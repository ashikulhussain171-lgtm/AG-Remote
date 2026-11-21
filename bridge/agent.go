package main

// AgentLink: connects to Antigravity over CDP, picks the window holding the agent chat,
// mirrors it, and performs actions (send, click, keys, screencast).

import (
	"crypto/sha1"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/url"
	"os"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

//go:embed pagelib.js
var pageLibSrc string

const libVersion = "1.2.0"

type Item struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Disabled bool   `json:"disabled"`
	InScroll bool   `json:"inScroll"`
	Btn      bool   `json:"btn"`
}

type TargetInfo struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Type  string `json:"type"`
	URL   string `json:"url"`
	Score int    `json:"score"`
	Hint  string `json:"hint"`
}

type State struct {
	CDP       string       `json:"cdp"`
	Error     string       `json:"error"`
	Targets   []TargetInfo `json:"targets"`
	ActiveID  string       `json:"activeId"`
	Found     bool         `json:"found"`
	Reason    string       `json:"reason"`
	Busy      bool         `json:"busy"`
	Pending   []Item       `json:"pending"`
	Controls  []Item       `json:"controls"`
	InputText string       `json:"inputText"`
	Platform  string       `json:"platform"`
	Screen    bool         `json:"screen"`
}

type Probe struct {
	Score    int    `json:"score"`
	Hint     string `json:"hint"`
	Title    string `json:"title"`
	Platform string `json:"platform"`
}

type pageSnap struct {
	OK        bool              `json:"ok"`
	Same      bool              `json:"same"`
	Reason    string            `json:"reason"`
	HTML      string            `json:"html"`
	WrapOpen  string            `json:"wrapOpen"`
	WrapClose string            `json:"wrapClose"`
	Vars      map[string]string `json:"vars"`
	HTMLClass string            `json:"htmlClass"`
	BodyClass string            `json:"bodyClass"`
	Bg        string            `json:"bg"`
	Color     string            `json:"color"`
	Font      string            `json:"font"`
	Text      string            `json:"text"`
	URLs      []string          `json:"urls"`
	Meta      *struct {
		Busy      bool   `json:"busy"`
		Pending   []Item `json:"pending"`
		Controls  []Item `json:"controls"`
		InputText string `json:"inputText"`
	} `json:"meta"`
}

type Snap struct {
	HTML      string            `json:"html"`
	WrapOpen  string            `json:"wrapOpen"`
	WrapClose string            `json:"wrapClose"`
	Vars      map[string]string `json:"vars"`
	HTMLClass string            `json:"htmlClass"`
	BodyClass string            `json:"bodyClass"`
	Bg        string            `json:"bg"`
	Color     string            `json:"color"`
	Font      string            `json:"font"`
	Text      string            `json:"text"`
	Key       string            `json:"key"`
	V         int               `json:"v"`
	At        int64             `json:"at"`
}

type Frame struct {
	Data string  `json:"data"`
	W    float64 `json:"w"`
	H    float64 `json:"h"`
}

type Events struct {
	OnState    func([]byte)
	OnSnap     func([]byte)
	OnCSS      func(hash string)
	OnOverlays func([]byte)
	OnFrame    func([]byte)
}

type tsess struct {
	s       *CDP
	target  Target
	probe   *Probe
	frameID string
	framed  atomic.Bool
}

type AgentLink struct {
	cfg *Config
	ev  Events

	mu        sync.Mutex
	sessions  map[string]*tsess
	activeID  string
	pinnedID  string
	state     State
	stateJSON []byte
	snap      *Snap
	snapJSON  []byte
	ovKey     string
	ovJSON    []byte
	cssHash   string
	cssText   string
	cssAt     time.Time

	allowed    sync.Map
	clients    atomic.Int32
	force      atomic.Bool
	screenMu   sync.Mutex
	screenSubs int
	screenOn   bool
	screenSess *CDP
}

func NewAgentLink(cfg *Config, ev Events) *AgentLink {
	a := &AgentLink{cfg: cfg, ev: ev, sessions: map[string]*tsess{}}
	a.state = State{CDP: "connecting", Targets: []TargetInfo{}, Pending: []Item{}, Controls: []Item{}}
	a.stateJSON, _ = json.Marshal(a.state)
	a.ovJSON = []byte("[]")
	a.force.Store(true)
	return a
}

func sha1hex(s string) string {
	h := sha1.Sum([]byte(s))
	return hex.EncodeToString(h[:])[:16]
}

func jsJSON(v any) string { b, _ := json.Marshal(v); return string(b) }

func (a *AgentLink) libCall(fn string, args []any) string {
	if args == nil {
		args = []any{}
	}
	return fmt.Sprintf("(function(){var A=(%s)(%s, %s);return JSON.stringify(A[%s].apply(null, %s));})()",
		pageLibSrc, jsJSON(libVersion), jsJSON(a.cfg.SelectorsCopy()), jsJSON(fn), jsJSON(args))
}

func (a *AgentLink) activeSess() (*tsess, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	e := a.sessions[a.activeID]
	if e == nil {
		return nil, errors.New("not connected to the Antigravity agent window")
	}
	return e, nil
}

func (a *AgentLink) call(fn string, args []any, out any) error {
	e, err := a.activeSess()
	if err != nil {
		return err
	}
	return e.s.EvalJSON(a.libCall(fn, args), out, 8*time.Second)
}

func (a *AgentLink) callOn(e *tsess, fn string, args []any, out any, timeout time.Duration) error {
	return e.s.EvalJSON(a.libCall(fn, args), out, timeout)
}

func (a *AgentLink) setState(fn func(s *State)) {
	a.mu.Lock()
	fn(&a.state)
	if a.state.Pending == nil {
		a.state.Pending = []Item{}
	}
	if a.state.Controls == nil {
		a.state.Controls = []Item{}
	}
	if a.state.Targets == nil {
		a.state.Targets = []TargetInfo{}
	}
	b, _ := json.Marshal(a.state)
	changed := string(b) != string(a.stateJSON)
	a.stateJSON = b
	a.mu.Unlock()
	if changed && a.ev.OnState != nil {
		a.ev.OnState(b)
	}
}

func (a *AgentLink) StateJSON() []byte { a.mu.Lock(); defer a.mu.Unlock(); return a.stateJSON }
func (a *AgentLink) SnapJSON() []byte  { a.mu.Lock(); defer a.mu.Unlock(); return a.snapJSON }
func (a *AgentLink) OverlaysJSON() []byte {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.ovJSON
}
func (a *AgentLink) CSS() (string, string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cssHash, a.cssText
}
func (a *AgentLink) Platform() string { a.mu.Lock(); defer a.mu.Unlock(); return a.state.Platform }
func (a *AgentLink) ForceSnap()       { a.force.Store(true) }
func (a *AgentLink) Pin(id string)    { a.mu.Lock(); a.pinnedID = id; a.mu.Unlock() }

func (a *AgentLink) Start() {
	go func() {
		for {
			a.discover()
			time.Sleep(2500 * time.Millisecond)
		}
	}()
	go a.pollLoop()
}

func (a *AgentLink) discover() {
	targets, err := listTargets(a.cfg.CDPHost, a.cfg.CDPPort)
	if err != nil {
		a.mu.Lock()
		for id, e := range a.sessions {
			e.s.Close()
			delete(a.sessions, id)
		}
		a.activeID = ""
		a.mu.Unlock()
		msg := fmt.Sprintf("Antigravity debug port %s:%d not reachable. Close Antigravity completely and start it through AGRemote-Bridge (or with --remote-debugging-port=%d).", a.cfg.CDPHost, a.cfg.CDPPort, a.cfg.CDPPort)
		a.setState(func(s *State) { s.CDP = "down"; s.Error = msg; s.Targets = nil; s.ActiveID = ""; s.Found = false })
		return
	}
	usable := map[string]Target{}
	order := []string{}
	for _, t := range targets {
		if (t.Type == "page" || t.Type == "iframe" || t.Type == "webview" || t.Type == "other") && !strings.HasPrefix(t.URL, "devtools:") && !strings.HasPrefix(t.URL, "chrome-extension:") {
			usable[t.ID] = t
			order = append(order, t.ID)
		}
	}
	a.mu.Lock()
	for id, e := range a.sessions {
		if _, ok := usable[id]; !ok || e.s.Closed() {
			e.s.Close()
			delete(a.sessions, id)
		}
	}
	a.mu.Unlock()

	for _, id := range order {
		t := usable[id]
		a.mu.Lock()
		e := a.sessions[id]
		a.mu.Unlock()
		if e == nil {
			s, err := cdpConnect(t)
			if err != nil {
				log.Printf("attach failed %q: %v", t.Title, err)
				continue
			}
			e = &tsess{s: s, target: t}
			tid := id
			s.OnClose(func() {
				a.mu.Lock()
				if a.sessions[tid] == e {
					delete(a.sessions, tid)
				}
				wasActive := a.activeID == tid
				if wasActive {
					a.activeID = ""
				}
				a.mu.Unlock()
				if wasActive {
					a.setState(func(st *State) { st.ActiveID = ""; st.Found = false })
				}
			})
			if _, err := s.Send("Page.enable", nil, 5*time.Second); err == nil {
				if raw, err := s.Send("Page.getFrameTree", nil, 5*time.Second); err == nil {
					var ft struct {
						FrameTree struct {
							Frame struct {
								ID string `json:"id"`
							} `json:"frame"`
						} `json:"frameTree"`
					}
					if json.Unmarshal(raw, &ft) == nil {
						e.frameID = ft.FrameTree.Frame.ID
					}
				}
			}
			a.mu.Lock()
			a.sessions[id] = e
			a.mu.Unlock()
		}
		var p Probe
		if err := a.callOn(e, "probe", nil, &p, 4*time.Second); err != nil {
			p = Probe{Score: -1}
		}
		a.mu.Lock()
		e.target = t
		e.probe = &p
		a.mu.Unlock()
	}

	a.mu.Lock()
	list := []TargetInfo{}
	for _, id := range order {
		e := a.sessions[id]
		if e == nil {
			continue
		}
		ti := TargetInfo{ID: id, Title: e.target.Title, Type: e.target.Type, URL: trunc(e.target.URL, 160), Score: -1}
		if e.probe != nil {
			if e.probe.Title != "" {
				ti.Title = e.probe.Title
			}
			ti.Score, ti.Hint = e.probe.Score, e.probe.Hint
		}
		list = append(list, ti)
	}
	next := ""
	if a.pinnedID != "" && a.sessions[a.pinnedID] != nil {
		next = a.pinnedID
	} else {
		cands := []TargetInfo{}
		for _, t := range list {
			if t.Score >= 20 {
				cands = append(cands, t)
			}
		}
		sort.SliceStable(cands, func(i, j int) bool { return cands[i].Score > cands[j].Score })
		cur := a.sessions[a.activeID]
		if cur != nil && cur.probe != nil && cur.probe.Score >= 20 && (len(cands) == 0 || cands[0].Score-cur.probe.Score < 15) {
			next = a.activeID
		} else if len(cands) > 0 {
			next = cands[0].ID
		}
	}
	changed := next != a.activeID
	platform := ""
	if e := a.sessions[next]; e != nil && e.probe != nil {
		platform = e.probe.Platform
	}
	a.mu.Unlock()

	if changed {
		a.stopScreencast()
		a.mu.Lock()
		a.activeID = next
		a.snap, a.snapJSON = nil, nil
		a.cssHash, a.cssText = "", ""
		a.mu.Unlock()
		a.force.Store(true)
		if next != "" {
			if err := a.RefreshCSS(); err != nil {
				log.Printf("css: %v", err)
			}
		}
		a.screenMu.Lock()
		subs := a.screenSubs
		a.screenMu.Unlock()
		if subs > 0 && next != "" {
			_ = a.startScreencast()
		}
	}
	errMsg := ""
	if next == "" {
		errMsg = "Connected to Antigravity, but no window with an agent chat input was found. Open the Agent panel / Agent Manager, or pick a window in Settings."
	}
	a.setState(func(s *State) {
		s.CDP = "up"
		s.Error = errMsg
		s.Targets = list
		s.ActiveID = next
		s.Platform = platform
	})
	a.mu.Lock()
	stale := next != "" && time.Since(a.cssAt) > 30*time.Second
	a.mu.Unlock()
	if stale {
		_ = a.RefreshCSS()
	}
}

func trunc(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func (a *AgentLink) RefreshCSS() error {
	var r struct {
		CSS  string   `json:"css"`
		URLs []string `json:"urls"`
	}
	e, err := a.activeSess()
	if err != nil {
		return err
	}
	if err := a.callOn(e, "css", nil, &r, 15*time.Second); err != nil {
		return err
	}
	for _, u := range r.URLs {
		a.allowed.Store(u, true)
	}
	h := sha1hex(r.CSS)
	a.mu.Lock()
	a.cssAt = time.Now()
	changed := h != a.cssHash
	if changed {
		a.cssHash, a.cssText = h, r.CSS
	}
	a.mu.Unlock()
	if changed && a.ev.OnCSS != nil {
		a.ev.OnCSS(h)
	}
	return nil
}

func (a *AgentLink) pollLoop() {
	for {
		t0 := time.Now()
		a.mu.Lock()
		active := a.activeID != ""
		a.mu.Unlock()
		if active && (a.clients.Load() > 0 || a.force.Load()) {
			if err := a.pollOnce(); err != nil {
				msg := err.Error()
				a.setState(func(s *State) { s.Found = false; s.Reason = msg })
			}
		}
		wait := time.Duration(a.cfg.Poll())*time.Millisecond - time.Since(t0)
		if wait < 150*time.Millisecond {
			wait = 150 * time.Millisecond
		}
		time.Sleep(wait)
	}
}

func (a *AgentLink) pollOnce() error {
	force := a.force.Swap(false)
	var r pageSnap
	if err := a.call("snapshot", []any{force}, &r); err != nil {
		return err
	}
	if !r.OK {
		a.setState(func(s *State) { s.Found = false; s.Reason = r.Reason })
		return nil
	}
	if !r.Same {
		for _, u := range r.URLs {
			a.allowed.Store(u, true)
		}
		key := sha1hex(r.HTML + jsJSON(r.Vars) + r.WrapOpen)
		var out []byte
		a.mu.Lock()
		if a.snap == nil || a.snap.Key != key || force {
			v := 1
			if a.snap != nil {
				v = a.snap.V + 1
			}
			a.snap = &Snap{HTML: r.HTML, WrapOpen: r.WrapOpen, WrapClose: r.WrapClose, Vars: r.Vars, HTMLClass: r.HTMLClass, BodyClass: r.BodyClass, Bg: r.Bg, Color: r.Color, Font: r.Font, Text: r.Text, Key: key, V: v, At: time.Now().UnixMilli()}
			a.snapJSON, _ = json.Marshal(a.snap)
			out = a.snapJSON
		}
		a.mu.Unlock()
		if out != nil && a.ev.OnSnap != nil {
			a.ev.OnSnap(out)
		}
		m := r.Meta
		a.setState(func(s *State) {
			s.Found, s.Reason = true, ""
			if m != nil {
				s.Busy, s.Pending, s.Controls, s.InputText = m.Busy, m.Pending, m.Controls, m.InputText
			}
		})
	} else {
		a.setState(func(s *State) { s.Found, s.Reason = true, "" })
	}
	var o struct {
		Overlays json.RawMessage `json:"overlays"`
		URLs     []string        `json:"urls"`
	}
	if err := a.call("overlays", nil, &o); err != nil {
		return err
	}
	for _, u := range o.URLs {
		a.allowed.Store(u, true)
	}
	k := sha1hex(string(o.Overlays))
	a.mu.Lock()
	changed := k != a.ovKey
	if changed {
		a.ovKey, a.ovJSON = k, o.Overlays
	}
	a.mu.Unlock()
	if changed && a.ev.OnOverlays != nil {
		a.ev.OnOverlays(o.Overlays)
	}
	return nil
}

// ---------------- actions ----------------

type Result map[string]any

func okRes() Result                { return Result{"ok": true} }
func failRes(reason string) Result { return Result{"ok": false, "reason": reason} }

func (a *AgentLink) mouseClick(x, y float64, button string, count int) error {
	e, err := a.activeSess()
	if err != nil {
		return err
	}
	if _, err := e.s.Send("Input.dispatchMouseEvent", map[string]any{"type": "mouseMoved", "x": x, "y": y}, 5*time.Second); err != nil {
		return err
	}
	buttons := 1
	if button == "right" {
		buttons = 2
	}
	for i := 1; i <= count; i++ {
		if _, err := e.s.Send("Input.dispatchMouseEvent", map[string]any{"type": "mousePressed", "x": x, "y": y, "button": button, "clickCount": i, "buttons": buttons}, 5*time.Second); err != nil {
			return err
		}
		if _, err := e.s.Send("Input.dispatchMouseEvent", map[string]any{"type": "mouseReleased", "x": x, "y": y, "button": button, "clickCount": i, "buttons": 0}, 5*time.Second); err != nil {
			return err
		}
	}
	return nil
}

type ClickRef struct {
	ID      string `json:"id,omitempty"`
	Path    []int  `json:"path,omitempty"`
	Tag     string `json:"tag,omitempty"`
	Overlay *int   `json:"overlay,omitempty"`
	Label   string `json:"label,omitempty"`
}

func (a *AgentLink) Click(ref ClickRef) (Result, error) {
	var t struct {
		OK     bool    `json:"ok"`
		Reason string  `json:"reason"`
		X      float64 `json:"x"`
		Y      float64 `json:"y"`
		Hit    bool    `json:"hit"`
		Label  string  `json:"label"`
	}
	if err := a.call("target", []any{ref}, &t); err != nil {
		return nil, err
	}
	if !t.OK {
		return failRes(t.Reason), nil
	}
	if t.Hit {
		if err := a.mouseClick(t.X, t.Y, "left", 1); err == nil {
			a.force.Store(true)
			return Result{"ok": true, "method": "mouse", "label": t.Label}, nil
		} else {
			log.Printf("mouse click failed, using DOM click: %v", err)
		}
	}
	var d Result
	if err := a.call("domClick", []any{ref}, &d); err != nil {
		return nil, err
	}
	a.force.Store(true)
	d["method"], d["label"] = "dom", t.Label
	return d, nil
}

type keyDef struct {
	key, code, text string
	vk              int
}

var namedKeys = map[string]keyDef{
	"Enter": {"Enter", "Enter", "\r", 13}, "Escape": {"Escape", "Escape", "", 27}, "Tab": {"Tab", "Tab", "\t", 9},
	"Backspace": {"Backspace", "Backspace", "", 8}, "Delete": {"Delete", "Delete", "", 46}, "ArrowUp": {"ArrowUp", "ArrowUp", "", 38},
	"ArrowDown": {"ArrowDown", "ArrowDown", "", 40}, "ArrowLeft": {"ArrowLeft", "ArrowLeft", "", 37}, "ArrowRight": {"ArrowRight", "ArrowRight", "", 39},
	"Home": {"Home", "Home", "", 36}, "End": {"End", "End", "", 35}, "PageUp": {"PageUp", "PageUp", "", 33}, "PageDown": {"PageDown", "PageDown", "", 34},
	"F1": {"F1", "F1", "", 112}, "F5": {"F5", "F5", "", 116}, "Space": {" ", "Space", " ", 32},
}
var symKeys = map[string][2]any{"/": {"Slash", 191}, "\\": {"Backslash", 220}, "`": {"Backquote", 192}, ",": {"Comma", 188}, ".": {"Period", 190}, ";": {"Semicolon", 186}, "=": {"Equal", 187}, "-": {"Minus", 189}, "[": {"BracketLeft", 219}, "]": {"BracketRight", 221}}
var letterRe = regexp.MustCompile(`^[A-Za-z]$`)
var digitRe = regexp.MustCompile(`^[0-9]$`)

func keyInfo(name string) (keyDef, bool) {
	if k, ok := namedKeys[name]; ok {
		return k, true
	}
	if letterRe.MatchString(name) {
		u := strings.ToUpper(name)
		l := strings.ToLower(name)
		return keyDef{l, "Key" + u, l, int(u[0])}, true
	}
	if digitRe.MatchString(name) {
		return keyDef{name, "Digit" + name, name, int(name[0])}, true
	}
	if s, ok := symKeys[name]; ok {
		return keyDef{name, s[0].(string), name, s[1].(int)}, true
	}
	return keyDef{}, false
}

type Mods struct {
	Alt   bool `json:"alt"`
	Ctrl  bool `json:"ctrl"`
	Meta  bool `json:"meta"`
	Shift bool `json:"shift"`
}

func (a *AgentLink) Key(name string, m Mods) (Result, error) {
	k, ok := keyInfo(name)
	if !ok {
		return failRes("unknown key " + name), nil
	}
	e, err := a.activeSess()
	if err != nil {
		return nil, err
	}
	mod := 0
	if m.Alt {
		mod |= 1
	}
	if m.Ctrl {
		mod |= 2
	}
	if m.Meta {
		mod |= 4
	}
	if m.Shift {
		mod |= 8
	}
	withText := k.text != "" && !(m.Ctrl || m.Meta || m.Alt)
	base := map[string]any{"key": k.key, "code": k.code, "windowsVirtualKeyCode": k.vk, "nativeVirtualKeyCode": k.vk, "modifiers": mod}
	down := map[string]any{}
	for kk, v := range base {
		down[kk] = v
	}
	if withText {
		down["type"], down["text"], down["unmodifiedText"] = "keyDown", k.text, k.text
	} else {
		down["type"] = "rawKeyDown"
	}
	if _, err := e.s.Send("Input.dispatchKeyEvent", down, 5*time.Second); err != nil {
		return nil, err
	}
	base["type"] = "keyUp"
	if _, err := e.s.Send("Input.dispatchKeyEvent", base, 5*time.Second); err != nil {
		return nil, err
	}
	a.force.Store(true)
	return okRes(), nil
}

func (a *AgentLink) TypeText(text string) (Result, error) {
	e, err := a.activeSess()
	if err != nil {
		return nil, err
	}
	if _, err := e.s.Send("Input.insertText", map[string]any{"text": text}, 5*time.Second); err != nil {
		return nil, err
	}
	a.force.Store(true)
	return okRes(), nil
}

var wsRe = regexp.MustCompile(`\s+`)

func (a *AgentLink) readInput() (string, error) {
	var s string
	err := a.call("readInput", nil, &s)
	return s, err
}

func (a *AgentLink) SendMessage(text string) (Result, error) {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	if strings.TrimSpace(text) == "" {
		return failRes("empty message"), nil
	}
	var f struct {
		OK      bool    `json:"ok"`
		Reason  string  `json:"reason"`
		Kind    string  `json:"kind"`
		X       float64 `json:"x"`
		Y       float64 `json:"y"`
		Focused *bool   `json:"focused"`
	}
	if err := a.call("focusInput", []any{true}, &f); err != nil {
		return nil, err
	}
	if !f.OK {
		return failRes(f.Reason), nil
	}
	if f.Kind == "monaco" || (f.Focused != nil && !*f.Focused) {
		_ = a.mouseClick(f.X, f.Y, "left", 1)
		mods := Mods{Ctrl: true}
		if strings.HasPrefix(a.Platform(), "Mac") {
			mods = Mods{Meta: true}
		}
		_, _ = a.Key("a", mods)
	}
	lines := strings.Split(text, "\n")
	for i, l := range lines {
		if l != "" {
			if _, err := a.TypeText(l); err != nil {
				return nil, err
			}
		}
		if i < len(lines)-1 {
			if _, err := a.Key("Enter", Mods{Shift: true}); err != nil {
				return nil, err
			}
		}
	}
	time.Sleep(120 * time.Millisecond)
	probe := strings.TrimSpace(wsRe.ReplaceAllString(text, " "))
	if r := []rune(probe); len(r) > 40 {
		probe = string(r[:40])
	}
	now, err := a.readInput()
	if err != nil {
		return nil, err
	}
	if !strings.Contains(now, probe) {
		_ = a.call("focusInput", []any{true}, nil)
		_ = a.call("execInsert", []any{text}, nil)
		time.Sleep(120 * time.Millisecond)
		if now, err = a.readInput(); err != nil {
			return nil, err
		}
		if !strings.Contains(now, probe) {
			return failRes("could not type into the agent input (text did not appear). Use the Screen tab, and send the Diagnostics output."), nil
		}
	}
	_ = a.call("focusInput", []any{false}, nil)
	if _, err := a.Key("Enter", Mods{}); err != nil {
		return nil, err
	}
	time.Sleep(450 * time.Millisecond)
	after, _ := a.readInput()
	if strings.Contains(after, probe) {
		var b struct {
			OK bool   `json:"ok"`
			ID string `json:"id"`
		}
		if a.call("sendButton", nil, &b) == nil && b.OK {
			_, _ = a.Click(ClickRef{ID: b.ID})
			time.Sleep(400 * time.Millisecond)
			after, _ = a.readInput()
		}
	}
	a.force.Store(true)
	if strings.Contains(after, probe) {
		return failRes("text was typed but Enter/Send did not submit it — tap the send button in the mirror"), nil
	}
	return okRes(), nil
}

func (a *AgentLink) Stop() (Result, error) {
	var b struct {
		OK bool   `json:"ok"`
		ID string `json:"id"`
	}
	if err := a.call("stopButton", nil, &b); err != nil {
		return nil, err
	}
	if b.OK {
		return a.Click(ClickRef{ID: b.ID})
	}
	if _, err := a.Key("Escape", Mods{}); err != nil {
		return nil, err
	}
	return Result{"ok": true, "method": "escape", "note": "no stop button found; sent Escape"}, nil
}

// ---------------- screen mirroring ----------------

func (a *AgentLink) viewport(e *tsess) (float64, float64, error) {
	raw, err := e.s.Send("Page.getLayoutMetrics", nil, 5*time.Second)
	if err != nil {
		return 0, 0, err
	}
	var lm struct {
		CSS *struct {
			W float64 `json:"clientWidth"`
			H float64 `json:"clientHeight"`
		} `json:"cssLayoutViewport"`
		Layout struct {
			W float64 `json:"clientWidth"`
			H float64 `json:"clientHeight"`
		} `json:"layoutViewport"`
	}
	if err := json.Unmarshal(raw, &lm); err != nil {
		return 0, 0, err
	}
	if lm.CSS != nil && lm.CSS.W > 0 {
		return lm.CSS.W, lm.CSS.H, nil
	}
	return lm.Layout.W, lm.Layout.H, nil
}

func (a *AgentLink) startScreencast() error {
	e, err := a.activeSess()
	if err != nil {
		return err
	}
	a.screenMu.Lock()
	if a.screenOn && a.screenSess == e.s {
		a.screenMu.Unlock()
		return nil
	}
	a.screenOn, a.screenSess = true, e.s
	a.screenMu.Unlock()
	if !e.framed.Swap(true) {
		s := e.s
		s.On("Page.screencastFrame", func(p json.RawMessage) {
			var f struct {
				Data      string `json:"data"`
				SessionID int    `json:"sessionId"`
				Metadata  struct {
					W float64 `json:"deviceWidth"`
					H float64 `json:"deviceHeight"`
				} `json:"metadata"`
			}
			if json.Unmarshal(p, &f) != nil {
				return
			}
			// Delayed ack caps the stream near 10 fps so a phone on Wi-Fi is not flooded.
			go func(id int) {
				time.Sleep(90 * time.Millisecond)
				_, _ = s.Send("Page.screencastFrameAck", map[string]any{"sessionId": id}, 5*time.Second)
			}(f.SessionID)
			if a.ev.OnFrame != nil {
				b, _ := json.Marshal(Frame{Data: f.Data, W: f.Metadata.W, H: f.Metadata.H})
				a.ev.OnFrame(b)
			}
		})
	}
	q := a.cfg.ScreenQuality
	if q <= 0 || q > 100 {
		q = 60
	}
	if _, err := e.s.Send("Page.startScreencast", map[string]any{"format": "jpeg", "quality": q, "maxWidth": 1600, "maxHeight": 1600, "everyNthFrame": 1}, 5*time.Second); err != nil {
		return err
	}
	// Screencast only emits on repaint, so push one still frame right away.
	if raw, err := e.s.Send("Page.captureScreenshot", map[string]any{"format": "jpeg", "quality": 60}, 10*time.Second); err == nil {
		var shot struct {
			Data string `json:"data"`
		}
		if json.Unmarshal(raw, &shot) == nil {
			if w, h, err := a.viewport(e); err == nil && a.ev.OnFrame != nil {
				b, _ := json.Marshal(Frame{Data: shot.Data, W: w, H: h})
				a.ev.OnFrame(b)
			}
		}
	}
	a.setState(func(s *State) { s.Screen = true })
	return nil
}

func (a *AgentLink) stopScreencast() {
	a.screenMu.Lock()
	if !a.screenOn {
		a.screenMu.Unlock()
		return
	}
	s := a.screenSess
	a.screenOn, a.screenSess = false, nil
	a.screenMu.Unlock()
	if s != nil {
		_, _ = s.Send("Page.stopScreencast", nil, 3*time.Second)
	}
	a.setState(func(st *State) { st.Screen = false })
}

func (a *AgentLink) ScreenSubscribe(delta int) {
	a.screenMu.Lock()
	a.screenSubs += delta
	if a.screenSubs < 0 {
		a.screenSubs = 0
	}
	subs := a.screenSubs
	a.screenMu.Unlock()
	if subs > 0 {
		if err := a.startScreencast(); err != nil {
			log.Printf("screencast: %v", err)
		}
	} else {
		a.stopScreencast()
	}
}

func (a *AgentLink) ScreenTap(fx, fy float64, right, double bool) (Result, error) {
	e, err := a.activeSess()
	if err != nil {
		return nil, err
	}
	w, h, err := a.viewport(e)
	if err != nil {
		return nil, err
	}
	x, y := float64(int(fx*w+0.5)), float64(int(fy*h+0.5))
	btn, n := "left", 1
	if right {
		btn = "right"
	}
	if double {
		n = 2
	}
	if err := a.mouseClick(x, y, btn, n); err != nil {
		return nil, err
	}
	return Result{"ok": true, "x": x, "y": y}, nil
}

func (a *AgentLink) ScreenScroll(fx, fy, dy float64) (Result, error) {
	e, err := a.activeSess()
	if err != nil {
		return nil, err
	}
	w, h, err := a.viewport(e)
	if err != nil {
		return nil, err
	}
	_, err = e.s.Send("Input.dispatchMouseEvent", map[string]any{"type": "mouseWheel", "x": float64(int(fx * w)), "y": float64(int(fy * h)), "deltaX": 0, "deltaY": dy}, 5*time.Second)
	if err != nil {
		return nil, err
	}
	return okRes(), nil
}

// ---------------- assets referenced by mirrored HTML/CSS ----------------

func (a *AgentLink) Asset(u string) []byte {
	if _, ok := a.allowed.Load(u); !ok {
		return nil
	}
	a.mu.Lock()
	sess := make([]*tsess, 0, len(a.sessions))
	for _, e := range a.sessions {
		sess = append(sess, e)
	}
	a.mu.Unlock()
	for _, e := range sess {
		if e.frameID == "" {
			continue
		}
		raw, err := e.s.Send("Page.getResourceContent", map[string]any{"frameId": e.frameID, "url": u}, 8*time.Second)
		if err != nil {
			continue
		}
		var r struct {
			Content       string `json:"content"`
			Base64Encoded bool   `json:"base64Encoded"`
		}
		if json.Unmarshal(raw, &r) != nil {
			continue
		}
		if r.Base64Encoded {
			if b, err := base64.StdEncoding.DecodeString(r.Content); err == nil {
				return b
			}
			continue
		}
		return []byte(r.Content)
	}
	// Fallback: vscode-file:// and file:// map to files inside the app install.
	var p string
	if strings.HasPrefix(u, "vscode-file://vscode-app/") {
		p = strings.TrimPrefix(u, "vscode-file://vscode-app")
	} else if strings.HasPrefix(u, "file:///") {
		p = strings.TrimPrefix(u, "file://")
	}
	if p == "" {
		return nil
	}
	if i := strings.IndexAny(p, "?#"); i >= 0 {
		p = p[:i]
	}
	if dec, err := url.PathUnescape(p); err == nil {
		p = dec
	}
	if runtime.GOOS == "windows" && len(p) > 3 && p[0] == '/' && p[2] == ':' {
		p = p[1:]
	}
	if st, err := os.Stat(p); err == nil && st.Mode().IsRegular() {
		if b, err := os.ReadFile(p); err == nil {
			return b
		}
	}
	return nil
}

func (a *AgentLink) Inspect() map[string]any {
	a.mu.Lock()
	type item struct {
		id string
		e  *tsess
	}
	items := []item{}
	for id, e := range a.sessions {
		items = append(items, item{id, e})
	}
	active := a.activeID
	a.mu.Unlock()
	sort.Slice(items, func(i, j int) bool { return items[i].id < items[j].id })
	out := []map[string]any{}
	for _, it := range items {
		m := map[string]any{}
		if err := a.callOn(it.e, "inspect", nil, &m, 8*time.Second); err != nil {
			m = map[string]any{"title": it.e.target.Title, "error": err.Error()}
		}
		m["id"], m["type"], m["active"] = it.id, it.e.target.Type, it.id == active
		out = append(out, m)
	}
	a.mu.Lock()
	st := a.state.CDP
	a.mu.Unlock()
	return map[string]any{"cdp": fmt.Sprintf("%s:%d", a.cfg.CDPHost, a.cfg.CDPPort), "state": st, "windows": out}
}
