package main

// Client for Antigravity's local language server ("LS"), the process that runs the agent.
// It speaks Connect-RPC with JSON bodies at
//   https|http://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/<Method>
// authenticated by the header x-codeium-csrf-token.
// Method names, request shapes and discovery files follow the open-source Porta project
// (github.com/L1M80/porta, MIT). They are not an official Google API and may change.

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const lsService = "exa.language_server_pb.LanguageServerService"

type LSInst struct {
	PID       int    `json:"pid"`
	Port      int    `json:"port"`
	AltPort   int    `json:"altPort,omitempty"`
	CSRF      string `json:"-"`
	App       string `json:"app"`
	Source    string `json:"source"`
	Workspace string `json:"workspace"`
	Proto     string `json:"proto"`
}

type LSClient struct {
	mu       sync.Mutex
	insts    []*LSInst
	scanned  time.Time
	lastErr  string
	owner    map[string]*LSInst
	scanLock sync.Mutex
}

var lsHTTP = &http.Client{
	Timeout: 20 * time.Second,
	Transport: &http.Transport{
		Proxy:           nil,
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, // LS uses a self-signed cert on 127.0.0.1 only
	},
}

func NewLSClient() *LSClient { return &LSClient{owner: map[string]*LSInst{}} }

type rpcError struct {
	Status int
	Msg    string
}

func (e *rpcError) Error() string { return fmt.Sprintf("LS HTTP %d: %s", e.Status, e.Msg) }

func (c *LSClient) post(inst *LSInst, port int, proto, method string, body []byte, timeout time.Duration) ([]byte, error) {
	url := fmt.Sprintf("%s://127.0.0.1:%d/%s/%s", proto, port, lsService, method)
	req, err := http.NewRequest("POST", url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-codeium-csrf-token", inst.CSRF)
	cl := *lsHTTP
	cl.Timeout = timeout
	resp, err := cl.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 256<<20))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		var e struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(b, &e)
		msg := e.Message
		if msg == "" {
			msg = truncBytes(strings.TrimSpace(string(b)), 300)
		}
		return nil, &rpcError{resp.StatusCode, msg}
	}
	return b, nil
}

// Call runs an RPC on one instance, trying the remembered transport first.
func (c *LSClient) Call(inst *LSInst, method string, body any, timeout time.Duration) (json.RawMessage, error) {
	if body == nil {
		body = map[string]any{}
	}
	b, _ := json.Marshal(body)
	protos := []string{"https", "http"}
	if inst.Proto == "http" {
		protos = []string{"http", "https"}
	}
	var lastErr error
	for _, port := range []int{inst.Port, inst.AltPort} {
		if port == 0 {
			continue
		}
		for _, p := range protos {
			out, err := c.post(inst, port, p, method, b, timeout)
			if err == nil {
				c.mu.Lock()
				inst.Proto, inst.Port = p, port
				c.mu.Unlock()
				return out, nil
			}
			var re *rpcError
			if errors.As(err, &re) {
				return nil, err // the server answered: transport is fine, the call failed
			}
			lastErr = err
		}
	}
	return nil, lastErr
}

// ---------------- discovery ----------------

func homeDir() string { h, _ := os.UserHomeDir(); return h }

func lsFromDaemonFiles() []*LSInst {
	out := []*LSInst{}
	for _, app := range []string{"antigravity", "antigravity-ide", "antigravity-cli"} {
		files, _ := filepath.Glob(filepath.Join(homeDir(), ".gemini", app, "daemon", "ls_*.json"))
		for _, f := range files {
			b, err := os.ReadFile(f)
			if err != nil {
				continue
			}
			var d struct {
				PID       int    `json:"pid"`
				HTTPSPort int    `json:"httpsPort"`
				HTTPPort  int    `json:"httpPort"`
				CSRF      string `json:"csrfToken"`
			}
			if json.Unmarshal(b, &d) != nil || d.HTTPSPort == 0 || d.CSRF == "" {
				continue
			}
			out = append(out, &LSInst{PID: d.PID, Port: d.HTTPSPort, CSRF: d.CSRF, App: app, Source: "daemon"})
		}
	}
	return out
}

var lsExeRe = regexp.MustCompile(`(?i)(?:^|[\\/])language_server(?:_[^/\\\s"']+)?(?:\.exe)?$`)

func argValue(args, name string) string {
	re := regexp.MustCompile(regexp.QuoteMeta(name) + `(?:=|\s+)("([^"]*)"|(\S+))`)
	m := re.FindStringSubmatch(args)
	if m == nil {
		return ""
	}
	if m[2] != "" {
		return m[2]
	}
	return m[3]
}

type procInfo struct {
	pid  int
	args string
}

func listProcesses() []procInfo {
	out := []procInfo{}
	if runtime.GOOS == "windows" {
		cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
			"Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'language_server*' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress")
		hideWindow(cmd)
		b, err := cmd.Output()
		if err != nil || len(bytes.TrimSpace(b)) == 0 {
			return out
		}
		var many []struct {
			ProcessId   int
			CommandLine string
		}
		if bytes.HasPrefix(bytes.TrimSpace(b), []byte("{")) {
			var one struct {
				ProcessId   int
				CommandLine string
			}
			if json.Unmarshal(b, &one) == nil {
				many = append(many, one)
			}
		} else {
			_ = json.Unmarshal(b, &many)
		}
		for _, p := range many {
			out = append(out, procInfo{p.ProcessId, p.CommandLine})
		}
		return out
	}
	b, err := exec.Command("ps", "-axo", "pid=,args=").Output()
	if err != nil {
		return out
	}
	for _, l := range strings.Split(string(b), "\n") {
		l = strings.TrimSpace(l)
		sp := strings.IndexByte(l, ' ')
		if sp < 0 || !strings.Contains(l, "language_server") {
			continue
		}
		pid, err := strconv.Atoi(l[:sp])
		if err == nil {
			out = append(out, procInfo{pid, strings.TrimSpace(l[sp+1:])})
		}
	}
	return out
}

func lsFromProcesses() []*LSInst {
	out := []*LSInst{}
	for _, p := range listProcesses() {
		exe := p.args
		if strings.HasPrefix(exe, `"`) {
			if i := strings.Index(exe[1:], `"`); i >= 0 {
				exe = exe[1 : i+1]
			}
		} else if i := strings.Index(strings.ToLower(exe), "language_server"); i >= 0 {
			end := strings.IndexAny(exe[i:], " \t")
			if end >= 0 {
				exe = exe[:i+end]
			}
		}
		if !lsExeRe.MatchString(strings.TrimSpace(exe)) {
			continue
		}
		csrf := argValue(p.args, "--csrf_token")
		if csrf == "" {
			continue
		}
		port, _ := strconv.Atoi(argValue(p.args, "--server_port"))
		alt, _ := strconv.Atoi(argValue(p.args, "--extension_server_port"))
		if port == 0 {
			port, alt = alt, 0
		}
		if port == 0 {
			continue
		}
		app := filepath.Base(argValue(p.args, "--app_data_dir"))
		if app == "." || app == "/" {
			app = ""
		}
		out = append(out, &LSInst{PID: p.pid, Port: port, AltPort: alt, CSRF: csrf, App: app, Source: "process"})
	}
	return out
}

func (c *LSClient) scan() {
	c.scanLock.Lock()
	defer c.scanLock.Unlock()
	cands := lsFromDaemonFiles()
	seen := map[int]bool{}
	for _, x := range cands {
		seen[x.PID] = true
	}
	for _, x := range lsFromProcesses() {
		if !seen[x.PID] {
			cands = append(cands, x)
			seen[x.PID] = true
		}
	}
	// Keep previously-working transport hints.
	c.mu.Lock()
	prev := map[string]*LSInst{}
	for _, x := range c.insts {
		prev[fmt.Sprintf("%d:%s", x.PID, x.CSRF)] = x
	}
	c.mu.Unlock()
	alive := []*LSInst{}
	var errs []string
	var wg sync.WaitGroup
	var amu sync.Mutex
	for _, x := range cands {
		if p := prev[fmt.Sprintf("%d:%s", x.PID, x.CSRF)]; p != nil {
			x.Proto = p.Proto
		}
		wg.Add(1)
		go func(x *LSInst) {
			defer wg.Done()
			raw, err := c.Call(x, "GetWorkspaceInfos", nil, 4*time.Second)
			amu.Lock()
			defer amu.Unlock()
			if err != nil {
				errs = append(errs, fmt.Sprintf("pid %d port %d: %v", x.PID, x.Port, err))
				return
			}
			var wi struct {
				WorkspaceInfos []struct {
					WorkspaceURI string `json:"workspaceUri"`
				} `json:"workspaceInfos"`
			}
			if json.Unmarshal(raw, &wi) == nil && len(wi.WorkspaceInfos) > 0 {
				x.Workspace = wi.WorkspaceInfos[0].WorkspaceURI
			}
			alive = append(alive, x)
		}(x)
	}
	wg.Wait()
	sort.Slice(alive, func(i, j int) bool { return alive[i].PID < alive[j].PID })
	c.mu.Lock()
	c.insts = alive
	c.scanned = time.Now()
	switch {
	case len(alive) > 0:
		c.lastErr = ""
	case len(cands) == 0:
		c.lastErr = "Antigravity's agent service (language server) was not found. Is Antigravity open?"
	default:
		c.lastErr = "Found the agent service but could not talk to it: " + strings.Join(errs, "; ")
	}
	c.mu.Unlock()
}

func (c *LSClient) Instances() []*LSInst {
	c.mu.Lock()
	stale := time.Since(c.scanned) > 8*time.Second || len(c.insts) == 0 && time.Since(c.scanned) > 2*time.Second
	c.mu.Unlock()
	if stale {
		c.scan()
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]*LSInst{}, c.insts...)
}

func (c *LSClient) Status() map[string]any {
	insts := c.Instances()
	c.mu.Lock()
	defer c.mu.Unlock()
	return map[string]any{"ok": len(insts) > 0, "instances": insts, "error": c.lastErr}
}

// ---------------- conversations ----------------

type Conv struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Status    string `json:"status"`
	Steps     int    `json:"steps"`
	Modified  string `json:"modified"`
	Workspace string `json:"workspace"`
	App       string `json:"app"`
	Traj      string `json:"trajectoryId"`
}

func (c *LSClient) Conversations() ([]Conv, error) {
	insts := c.Instances()
	if len(insts) == 0 {
		c.mu.Lock()
		e := c.lastErr
		c.mu.Unlock()
		return nil, errors.New(e)
	}
	byID := map[string]Conv{}
	var firstErr error
	for _, inst := range insts {
		raw, err := c.Call(inst, "GetAllCascadeTrajectories", nil, 10*time.Second)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		var r struct {
			Summaries map[string]struct {
				Summary      string `json:"summary"`
				StepCount    int    `json:"stepCount"`
				LastModified string `json:"lastModifiedTime"`
				Status       string `json:"status"`
				TrajectoryID string `json:"trajectoryId"`
				Workspaces   []struct {
					URI string `json:"workspaceFolderAbsoluteUri"`
				} `json:"workspaces"`
			} `json:"trajectorySummaries"`
		}
		if err := json.Unmarshal(raw, &r); err != nil {
			continue
		}
		for id, s := range r.Summaries {
			ws := ""
			if len(s.Workspaces) > 0 {
				ws = path.Base(strings.TrimRight(s.Workspaces[0].URI, "/"))
			}
			cv := Conv{ID: id, Title: s.Summary, Status: s.Status, Steps: s.StepCount, Modified: s.LastModified, Workspace: ws, App: inst.App, Traj: s.TrajectoryID}
			if old, ok := byID[id]; !ok || cv.Modified > old.Modified {
				byID[id] = cv
				c.mu.Lock()
				c.owner[id] = inst
				c.mu.Unlock()
			}
		}
	}
	if len(byID) == 0 && firstErr != nil {
		return nil, firstErr
	}
	out := make([]Conv, 0, len(byID))
	for _, v := range byID {
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool {
		ri, rj := out[i].Status == "CASCADE_RUN_STATUS_RUNNING", out[j].Status == "CASCADE_RUN_STATUS_RUNNING"
		if ri != rj {
			return ri
		}
		return out[i].Modified > out[j].Modified
	})
	return out, nil
}

// forConv calls method on the instance that owns the conversation, falling back to all.
func (c *LSClient) forConv(id, method string, body any, timeout time.Duration) (json.RawMessage, error) {
	c.mu.Lock()
	inst := c.owner[id]
	c.mu.Unlock()
	if inst != nil {
		out, err := c.Call(inst, method, body, timeout)
		if err == nil {
			return out, nil
		}
	}
	var lastErr error = errors.New("conversation not found on any Antigravity agent service")
	for _, x := range c.Instances() {
		if x == inst {
			continue
		}
		out, err := c.Call(x, method, body, timeout)
		if err == nil {
			c.mu.Lock()
			c.owner[id] = x
			c.mu.Unlock()
			return out, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

// Steps returns steps from offset to the end. A step the LS cannot serialize is replaced by a placeholder.
func (c *LSClient) Steps(id string, offset int) (map[string]any, error) {
	if offset < 0 {
		offset = 0
	}
	steps := []json.RawMessage{}
	cur := offset
	skips := 0
	for len(steps) < 3000 {
		raw, err := c.forConv(id, "GetCascadeTrajectorySteps", map[string]any{"cascadeId": id, "stepOffset": cur}, 20*time.Second)
		if err != nil {
			var re *rpcError
			if errors.As(err, &re) && len(steps)+skips < 3000 && skips < 5 && cur > offset {
				steps = append(steps, json.RawMessage(`{"type":"AGREMOTE_UNREADABLE","status":"CORTEX_STEP_STATUS_ERROR"}`))
				cur++
				skips++
				continue
			}
			if len(steps) == 0 {
				return nil, err
			}
			break
		}
		var r struct {
			Steps []json.RawMessage `json:"steps"`
		}
		if err := json.Unmarshal(raw, &r); err != nil {
			return nil, err
		}
		if len(r.Steps) == 0 {
			break
		}
		steps = append(steps, r.Steps...)
		cur += len(r.Steps)
		skips = 0
	}
	res := map[string]any{"ok": true, "offset": offset, "steps": steps}
	if raw, err := c.forConv(id, "GetCascadeTrajectory", map[string]any{"cascadeId": id}, 10*time.Second); err == nil {
		var d struct {
			Status   string `json:"status"`
			NumTotal int    `json:"numTotalSteps"`
		}
		if json.Unmarshal(raw, &d) == nil {
			res["status"], res["total"] = d.Status, d.NumTotal
		}
	}
	return res, nil
}

func lsMetadata() map[string]any {
	return map[string]any{"ideName": "agremote", "ideVersion": version, "extensionVersion": version}
}

// Send posts a user message; with an empty id it starts a new conversation first.
func (c *LSClient) Send(id, text, mode string) (map[string]any, error) {
	if strings.TrimSpace(text) == "" {
		return nil, errors.New("empty message")
	}
	if id == "" {
		insts := c.Instances()
		if len(insts) == 0 {
			return nil, errors.New("Antigravity's agent service is not reachable")
		}
		inst := insts[0]
		for _, x := range insts {
			if x.Workspace != "" {
				inst = x
				break
			}
		}
		req := map[string]any{"metadata": lsMetadata(), "source": "CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT"}
		if inst.Workspace != "" {
			req["workspaceFolderAbsoluteUri"] = inst.Workspace
			req["workspaceUris"] = []string{inst.Workspace}
		}
		raw, err := c.Call(inst, "StartCascade", req, 20*time.Second)
		if err != nil {
			return nil, err
		}
		var r struct {
			CascadeID string `json:"cascadeId"`
		}
		if json.Unmarshal(raw, &r) != nil || r.CascadeID == "" {
			return nil, errors.New("StartCascade returned no cascadeId")
		}
		id = r.CascadeID
		c.mu.Lock()
		c.owner[id] = inst
		c.mu.Unlock()
	}
	req := map[string]any{"metadata": lsMetadata(), "cascadeId": id, "items": []map[string]string{{"type": "text", "text": text}}}
	switch mode {
	case "planning":
		req["cascadeConfig"] = map[string]any{"plannerConfig": map[string]any{"plannerTypeConfig": map[string]any{"planning": map[string]any{}}}}
	case "fast":
		req["cascadeConfig"] = map[string]any{"plannerConfig": map[string]any{"plannerTypeConfig": map[string]any{"conversational": map[string]any{}}}}
	}
	if _, err := c.forConv(id, "SendUserCascadeMessage", req, 30*time.Second); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "id": id}, nil
}

func (c *LSClient) Stop(id string) error {
	_, err := c.forConv(id, "CancelCascadeInvocation", map[string]any{"cascadeId": id}, 10*time.Second)
	return err
}

// Interact answers a waiting step: permission, filePermission or askQuestion.
func (c *LSClient) Interact(id string, interaction map[string]any) error {
	if _, ok := interaction["trajectoryId"].(string); !ok {
		return errors.New("interaction.trajectoryId missing")
	}
	allowed := 0
	for _, k := range []string{"permission", "filePermission", "askQuestion"} {
		if _, ok := interaction[k]; ok {
			allowed++
		}
	}
	if allowed != 1 {
		return errors.New("interaction must contain exactly one of permission, filePermission, askQuestion")
	}
	_, err := c.forConv(id, "HandleCascadeUserInteraction", map[string]any{"cascadeId": id, "interaction": interaction}, 15*time.Second)
	return err
}

// ---------------- background watcher for alerts ----------------

type Waiting struct {
	Conv  string `json:"conv"`
	Title string `json:"title"`
	Step  int    `json:"step"`
	Label string `json:"label"`
}

// Watch reports conversations that are running and steps waiting for the user.
func (c *LSClient) Watch() (running bool, waiting []Waiting, err error) {
	convs, err := c.Conversations()
	if err != nil {
		return false, nil, err
	}
	waiting = []Waiting{}
	for _, cv := range convs {
		if cv.Status != "CASCADE_RUN_STATUS_RUNNING" {
			continue
		}
		running = true
		off := cv.Steps - 6
		if off < 0 {
			off = 0
		}
		raw, err := c.forConv(cv.ID, "GetCascadeTrajectorySteps", map[string]any{"cascadeId": cv.ID, "stepOffset": off}, 10*time.Second)
		if err != nil {
			continue
		}
		var r struct {
			Steps []struct {
				Type     string `json:"type"`
				Status   string `json:"status"`
				Metadata struct {
					ToolSummary string `json:"toolSummary"`
				} `json:"metadata"`
				RunCommand *struct {
					CommandLine         string `json:"commandLine"`
					ProposedCommandLine string `json:"proposedCommandLine"`
				} `json:"runCommand"`
			} `json:"steps"`
		}
		if json.Unmarshal(raw, &r) != nil {
			continue
		}
		for i, s := range r.Steps {
			if s.Status != "CORTEX_STEP_STATUS_WAITING" {
				continue
			}
			label := s.Metadata.ToolSummary
			if s.RunCommand != nil {
				label = "Run: " + firstNonEmpty(s.RunCommand.CommandLine, s.RunCommand.ProposedCommandLine)
			}
			if label == "" {
				label = strings.ToLower(strings.ReplaceAll(strings.TrimPrefix(s.Type, "CORTEX_STEP_TYPE_"), "_", " "))
			}
			waiting = append(waiting, Waiting{Conv: cv.ID, Title: cv.Title, Step: off + i, Label: truncRunes(label, 120)})
		}
	}
	return running, waiting, nil
}

func firstNonEmpty(xs ...string) string {
	for _, x := range xs {
		if x != "" {
			return x
		}
	}
	return ""
}
