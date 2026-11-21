package main

// Reads Antigravity conversation history from disk.
// Layout seen in Antigravity bug reports (verify on your install):
//   ~/.gemini/<app>/brain/<id>/                              artifacts: task.md, implementation_plan.md, walkthrough.md, images
//   ~/.gemini/<app>/brain/<id>/.system_generated/logs/*.jsonl  transcripts (newer builds: transcript_full.jsonl)
//   ~/.gemini/<app>/annotations/<id>.pbtxt                    text-proto metadata, usually holds the title
//   ~/.gemini/<app>/conversations/<id>.pb                     binary/encrypted, not readable here
// <app> is antigravity, antigravity-ide or antigravity-cli depending on the build.

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

var idRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)
var titleRe = regexp.MustCompile(`(?i)\b\w*(title|summary)\w*\s*:\s*"((?:[^"\\]|\\.)*)"`)
var transcriptExt = regexp.MustCompile(`(?i)\.(jsonl|json|txt|log)$`)

type FileEntry struct {
	Rel   string  `json:"rel"`
	Size  int64   `json:"size"`
	Mtime float64 `json:"mtime"`
	abs   string
}

func historyRoots(c *Config) []string {
	list := c.historyRootsRuntime
	if len(list) == 0 {
		c.mu.Lock()
		list = append([]string{}, c.HistoryRoots...)
		c.mu.Unlock()
	}
	if len(list) == 0 {
		home, _ := os.UserHomeDir()
		for _, d := range []string{"antigravity", "antigravity-ide", "antigravity-cli"} {
			list = append(list, filepath.Join(home, ".gemini", d))
		}
	}
	out := []string{}
	for _, r := range list {
		if st, err := os.Stat(r); err == nil && st.IsDir() {
			out = append(out, r)
		}
	}
	return out
}

func mtimeMs(fi os.FileInfo) float64 { return float64(fi.ModTime().UnixNano()) / 1e6 }

func walkFiles(dir string, maxDepth int) []FileEntry {
	out := []FileEntry{}
	var rec func(d string, depth int)
	rec = func(d string, depth int) {
		ents, err := os.ReadDir(d)
		if err != nil {
			return
		}
		for _, e := range ents {
			full := filepath.Join(d, e.Name())
			if e.IsDir() {
				if depth < maxDepth {
					rec(full, depth+1)
				}
				continue
			}
			if !e.Type().IsRegular() {
				continue
			}
			fi, err := e.Info()
			if err != nil {
				continue
			}
			rel, _ := filepath.Rel(dir, full)
			out = append(out, FileEntry{Rel: filepath.ToSlash(rel), Size: fi.Size(), Mtime: mtimeMs(fi), abs: full})
		}
	}
	rec(dir, 0)
	return out
}

func readTitle(root, id string) string {
	b, err := os.ReadFile(filepath.Join(root, "annotations", id+".pbtxt"))
	if err != nil {
		return ""
	}
	m := titleRe.FindSubmatch(b)
	if m == nil {
		return ""
	}
	if s, err := strconv.Unquote(`"` + string(m[2]) + `"`); err == nil {
		return s
	}
	return string(m[2])
}

func transcriptFiles(dir string) []FileEntry {
	logs := filepath.Join(dir, ".system_generated", "logs")
	files := []FileEntry{}
	for _, f := range walkFiles(logs, 2) {
		if transcriptExt.MatchString(f.Rel) {
			f.Rel = ".system_generated/logs/" + f.Rel
			files = append(files, f)
		}
	}
	sort.SliceStable(files, func(i, j int) bool {
		ti, tj := strings.Contains(files[i].Rel, "transcript_full"), strings.Contains(files[j].Rel, "transcript_full")
		if ti != tj {
			return ti
		}
		return files[i].Size > files[j].Size
	})
	return files
}

// textOf pulls human-readable text out of an unknown JSON event shape.
func textOf(o any, depth int) string {
	if o == nil || depth > 4 {
		return ""
	}
	switch v := o.(type) {
	case string:
		return v
	case []any:
		parts := []string{}
		for _, x := range v {
			if t := textOf(x, depth+1); t != "" {
				parts = append(parts, t)
			}
		}
		return strings.Join(parts, "\n")
	case map[string]any:
		for _, k := range []string{"text", "content", "message", "prompt", "userInput", "user_input", "response", "output", "markdown", "body", "parts", "items", "value"} {
			if x, ok := v[k]; ok {
				if t := textOf(x, depth+1); t != "" {
					return t
				}
			}
		}
	}
	return ""
}

func roleOf(o any) string {
	m, ok := o.(map[string]any)
	if !ok {
		return ""
	}
	for _, k := range []string{"role", "type", "source", "author", "kind", "step_type", "stepType", "event", "sender"} {
		if s, ok := m[k].(string); ok {
			return s
		}
	}
	return ""
}

var userRe = regexp.MustCompile(`(?i)user|human`)

func firstUserText(file string) string {
	f, err := os.Open(file)
	if err != nil {
		return ""
	}
	defer f.Close()
	head, _ := io.ReadAll(io.LimitReader(f, 64*1024))
	for _, line := range strings.Split(string(head), "\n") {
		var o any
		if json.Unmarshal([]byte(line), &o) != nil {
			continue
		}
		if userRe.MatchString(roleOf(o)) {
			if t := strings.TrimSpace(textOf(o, 0)); t != "" {
				return truncRunes(t, 120)
			}
		}
	}
	return ""
}

func truncRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

type HistItem struct {
	Key        string   `json:"key"`
	App        string   `json:"app"`
	ID         string   `json:"id"`
	Title      *string  `json:"title"`
	Mtime      float64  `json:"mtime"`
	Transcript bool     `json:"transcript"`
	Artifacts  []string `json:"artifacts"`
	FileCount  int      `json:"fileCount"`
	BinaryOnly bool     `json:"binaryOnly,omitempty"`
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func historyList(c *Config) []HistItem {
	out := []HistItem{}
	seen := map[string]bool{}
	for _, root := range historyRoots(c) {
		app := filepath.Base(root)
		ents, _ := os.ReadDir(filepath.Join(root, "brain"))
		for _, d := range ents {
			if !d.IsDir() || !idRe.MatchString(d.Name()) {
				continue
			}
			id := d.Name()
			dir := filepath.Join(root, "brain", id)
			files := walkFiles(dir, 4)
			tr := transcriptFiles(dir)
			var mt float64
			if fi, err := os.Stat(dir); err == nil {
				mt = mtimeMs(fi)
			}
			arts := []string{}
			for _, f := range files {
				if f.Mtime > mt {
					mt = f.Mtime
				}
				if !strings.HasPrefix(f.Rel, ".system_generated/") && len(arts) < 20 {
					arts = append(arts, f.Rel)
				}
			}
			title := readTitle(root, id)
			if title == "" && len(tr) > 0 {
				title = firstUserText(tr[0].abs)
			}
			out = append(out, HistItem{Key: app + "/" + id, App: app, ID: id, Title: strPtr(title), Mtime: mt, Transcript: len(tr) > 0, Artifacts: arts, FileCount: len(files)})
			seen[app+"/"+id] = true
		}
		pbs, _ := os.ReadDir(filepath.Join(root, "conversations"))
		for _, f := range pbs {
			name := f.Name()
			ext := filepath.Ext(name)
			if ext != ".pb" && ext != ".db" {
				continue
			}
			id := strings.TrimSuffix(name, ext)
			if !idRe.MatchString(id) || seen[app+"/"+id] {
				continue
			}
			var mt float64
			if fi, err := f.Info(); err == nil {
				mt = mtimeMs(fi)
			}
			out = append(out, HistItem{Key: app + "/" + id, App: app, ID: id, Title: strPtr(readTitle(root, id)), Mtime: mt, Artifacts: []string{}, BinaryOnly: true})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Mtime > out[j].Mtime })
	return out
}

func resolveConv(c *Config, app, id string) (root, dir string, ok bool) {
	if !idRe.MatchString(app) || !idRe.MatchString(id) {
		return "", "", false
	}
	for _, r := range historyRoots(c) {
		if filepath.Base(r) == app {
			return r, filepath.Join(r, "brain", id), true
		}
	}
	return "", "", false
}

type HistEvent struct {
	Role string `json:"role"`
	Text string `json:"text"`
	Raw  string `json:"raw,omitempty"`
}

func historyDetail(c *Config, app, id string) map[string]any {
	root, dir, ok := resolveConv(c, app, id)
	if !ok {
		return nil
	}
	files := []FileEntry{}
	tr := []FileEntry{}
	if st, err := os.Stat(dir); err == nil && st.IsDir() {
		files = walkFiles(dir, 4)
		tr = transcriptFiles(dir)
	}
	events := []HistEvent{}
	source := ""
	truncated := false
	if len(tr) > 0 {
		source = tr[0].Rel
		const max = 20 << 20
		const maxEvents = 3000
		f, err := os.Open(tr[0].abs)
		if err == nil {
			if tr[0].Size > max {
				_, _ = f.Seek(tr[0].Size-max, io.SeekStart)
				truncated = true
			}
			data, _ := io.ReadAll(io.LimitReader(f, max))
			f.Close()
			text := string(data)
			if truncated {
				if i := strings.IndexByte(text, '\n'); i >= 0 {
					text = text[i+1:]
				}
			}
			lines := []string{}
			sc := bufio.NewScanner(strings.NewReader(text))
			sc.Buffer(make([]byte, 1<<20), 64<<20)
			for sc.Scan() {
				if strings.TrimSpace(sc.Text()) != "" {
					lines = append(lines, sc.Text())
				}
			}
			start := 0
			if len(lines) > maxEvents {
				start = len(lines) - maxEvents
				truncated = true
			}
			for _, l := range lines[start:] {
				var o any
				if json.Unmarshal([]byte(l), &o) != nil {
					events = append(events, HistEvent{Role: "raw", Text: truncBytes(l, 4000)})
					continue
				}
				t := textOf(o, 0)
				rawB, _ := json.Marshal(o)
				raw := string(rawB)
				ev := HistEvent{Role: roleOf(o)}
				if t != "" {
					ev.Text = truncRunes(t, 20000)
					if len(raw) > 6000 {
						raw = truncBytes(raw, 6000) + "…"
					}
				} else {
					raw = truncBytes(raw, 12000)
				}
				ev.Raw = raw
				events = append(events, ev)
			}
		}
	}
	return map[string]any{"app": app, "id": id, "title": strPtr(readTitle(root, id)), "source": strPtr(source), "truncated": truncated, "events": events, "files": files}
}

func truncBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	// back off to a rune boundary
	for n > 0 && n < len(s) && (s[n]&0xC0) == 0x80 {
		n--
	}
	return s[:n]
}

func historyFilePath(c *Config, app, id, rel string) string {
	_, dir, ok := resolveConv(c, app, id)
	if !ok || rel == "" {
		return ""
	}
	base, _ := filepath.Abs(dir)
	p, _ := filepath.Abs(filepath.Join(base, filepath.FromSlash(rel)))
	if !strings.HasPrefix(p, base+string(filepath.Separator)) {
		return ""
	}
	if st, err := os.Stat(p); err == nil && st.Mode().IsRegular() {
		return p
	}
	return ""
}
