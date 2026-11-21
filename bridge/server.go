package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"io"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

//go:embed web
var webFS embed.FS

type sseMsg struct {
	event string
	data  []byte
}

type sseClient struct {
	id     string
	ch     chan sseMsg
	kill   chan struct{}
	once   sync.Once
	screen bool
	lite   bool
}

func (c *sseClient) drop() { c.once.Do(func() { close(c.kill) }) }

type Server struct {
	cfg  *Config
	link *AgentLink

	cmu     sync.Mutex
	clients map[string]*sseClient

	fmu         sync.Mutex
	fails       map[string]*failRec
	globalFails int
}

type failRec struct {
	n     int
	until time.Time
}

func NewServer(cfg *Config) *Server {
	s := &Server{cfg: cfg, clients: map[string]*sseClient{}, fails: map[string]*failRec{}}
	s.link = NewAgentLink(cfg, Events{
		OnState:    func(b []byte) { s.broadcast("state", b, func(c *sseClient) bool { return true }) },
		OnSnap:     func(b []byte) { s.broadcast("snap", b, notLite) },
		OnCSS:      func(h string) { s.broadcast("css", []byte(jsJSON(map[string]string{"hash": h})), notLite) },
		OnOverlays: func(b []byte) { s.broadcast("overlays", b, notLite) },
		OnFrame:    func(b []byte) { s.broadcast("frame", b, func(c *sseClient) bool { return c.screen && !c.lite }) },
	})
	return s
}

func notLite(c *sseClient) bool { return !c.lite }

func (s *Server) broadcast(event string, data []byte, filter func(*sseClient) bool) {
	s.cmu.Lock()
	defer s.cmu.Unlock()
	for _, c := range s.clients {
		if !filter(c) {
			continue
		}
		select {
		case c.ch <- sseMsg{event, data}:
		default:
			if event != "frame" { // a slow phone missed a real update: make it reconnect for a full resync
				c.drop()
			}
		}
	}
}

func sha256hex(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func cookieToken(r *http.Request) string {
	c, err := r.Cookie("agrc")
	if err != nil || len(c.Value) != 64 {
		return ""
	}
	return c.Value
}

func (s *Server) authed(r *http.Request) bool {
	t := cookieToken(r)
	if t == "" {
		return false
	}
	h := sha256hex(t)
	s.cfg.mu.Lock()
	defer s.cfg.mu.Unlock()
	return contains(s.cfg.Sessions, h)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	if b, ok := v.([]byte); ok {
		_, _ = w.Write(b)
		return
	}
	_ = json.NewEncoder(w).Encode(v)
}

func textResp(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_, _ = io.WriteString(w, msg)
}

func readJSON(r *http.Request, limit int64, v any) error {
	return json.NewDecoder(io.LimitReader(r.Body, limit)).Decode(v)
}

func mimeOf(p string) string {
	if i := strings.IndexAny(p, "?#"); i >= 0 {
		p = p[:i]
	}
	switch strings.ToLower(path.Ext(p)) {
	case ".woff2":
		return "font/woff2"
	case ".woff":
		return "font/woff"
	case ".ttf":
		return "font/ttf"
	case ".otf":
		return "font/otf"
	case ".svg":
		return "image/svg+xml"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".css":
		return "text/css"
	case ".js":
		return "text/javascript"
	case ".html":
		return "text/html; charset=utf-8"
	case ".webmanifest":
		return "application/manifest+json"
	case ".json":
		return "application/json"
	}
	return "application/octet-stream"
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Referrer-Policy", "no-referrer")
	defer func() {
		if e := recover(); e != nil {
			log.Printf("panic %s %s: %v", r.Method, r.URL.Path, e)
			writeJSON(w, 500, failRes("internal error"))
		}
	}()
	if strings.HasPrefix(r.URL.Path, "/api/") {
		s.api(w, r)
		return
	}
	p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if p == "" || p == "." {
		p = "index.html"
	}
	sub, _ := fs.Sub(webFS, "web")
	b, err := fs.ReadFile(sub, p)
	if err != nil {
		textResp(w, 404, "not found")
		return
	}
	w.Header().Set("Content-Type", mimeOf(p))
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(b)
}

func clientIP(r *http.Request) string {
	h, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return h
}

func (s *Server) api(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	q := r.URL.Query()

	if p == "/api/ping" {
		host, _ := os.Hostname()
		writeJSON(w, 200, map[string]any{"app": "antigravity-remote", "host": host, "v": version})
		return
	}

	if p == "/api/pair" && r.Method == http.MethodPost {
		s.pair(w, r)
		return
	}
	if !s.authed(r) {
		writeJSON(w, 401, failRes("not paired"))
		return
	}
	if r.Method == http.MethodPost && r.Header.Get("X-AGRC") != "1" {
		writeJSON(w, 403, failRes("missing header"))
		return
	}

	switch p {
	case "/api/me":
		host, _ := os.Hostname()
		s.cfg.mu.Lock()
		resp := map[string]any{"ok": true, "host": host, "cdpPort": s.cfg.CDPPort, "workspaces": append([]string{}, s.cfg.Workspaces...), "selectors": s.cfg.Selectors, "pollMs": s.cfg.PollMs, "version": version}
		s.cfg.mu.Unlock()
		resp["historyRoots"] = historyRoots(s.cfg)
		writeJSON(w, 200, resp)
		return
	case "/api/logout":
		if r.Method == http.MethodPost {
			h := sha256hex(cookieToken(r))
			_ = s.cfg.Update(func(c *Config) {
				out := c.Sessions[:0]
				for _, x := range c.Sessions {
					if x != h {
						out = append(out, x)
					}
				}
				c.Sessions = out
			})
			http.SetCookie(w, &http.Cookie{Name: "agrc", Value: "", Path: "/", MaxAge: -1})
			writeJSON(w, 200, okRes())
			return
		}
	case "/api/events":
		s.events(w, r)
		return
	case "/api/state":
		writeJSON(w, 200, s.link.StateJSON())
		return
	case "/api/snap":
		if b := s.link.SnapJSON(); b != nil {
			writeJSON(w, 200, b)
		} else {
			writeJSON(w, 200, map[string]any{})
		}
		return
	case "/api/css":
		_, css := s.link.CSS()
		if css == "" {
			textResp(w, 404, "no css yet")
			return
		}
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
		w.Header().Set("Cache-Control", "private, max-age=86400")
		_, _ = io.WriteString(w, css)
		return
	case "/api/asset":
		u := q.Get("u")
		b := s.link.Asset(u)
		if b == nil {
			textResp(w, 404, "not found")
			return
		}
		w.Header().Set("Content-Type", mimeOf(u))
		w.Header().Set("Cache-Control", "private, max-age=86400")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
		_, _ = w.Write(b)
		return
	}

	if r.Method == http.MethodPost {
		s.post(w, r, p)
		return
	}

	switch p {
	case "/api/inspect":
		writeJSON(w, 200, s.link.Inspect())
	case "/api/history":
		writeJSON(w, 200, map[string]any{"roots": historyRoots(s.cfg), "items": historyList(s.cfg)})
	case "/api/history/item":
		d := historyDetail(s.cfg, q.Get("app"), q.Get("id"))
		if d == nil {
			writeJSON(w, 404, failRes("not found"))
			return
		}
		writeJSON(w, 200, d)
	case "/api/history/file":
		fp := historyFilePath(s.cfg, q.Get("app"), q.Get("id"), q.Get("p"))
		if fp == "" {
			textResp(w, 404, "not found")
			return
		}
		st, err := os.Stat(fp)
		if err != nil || st.Size() > 20<<20 {
			textResp(w, 413, "too large")
			return
		}
		ext := strings.ToLower(filepath.Ext(fp))
		ct := mimeOf(fp)
		if ext == ".md" || ext == ".txt" || ext == ".json" || ext == ".jsonl" || ext == ".log" || ct == "application/octet-stream" {
			ct = "text/plain; charset=utf-8"
		}
		w.Header().Set("Content-Type", ct)
		w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		f, err := os.Open(fp)
		if err != nil {
			textResp(w, 404, "not found")
			return
		}
		defer f.Close()
		_, _ = io.Copy(w, f)
	case "/api/fs/list":
		writeJSON(w, 200, fsList(s.cfg, q.Get("w"), q.Get("p")))
	case "/api/fs/read":
		writeJSON(w, 200, fsRead(s.cfg, q.Get("w"), q.Get("p")))
	case "/api/git/status":
		writeJSON(w, 200, gitStatus(s.cfg, q.Get("w")))
	case "/api/git/diff":
		writeJSON(w, 200, gitDiff(s.cfg, q.Get("w"), q.Get("p")))
	default:
		writeJSON(w, 404, failRes("unknown endpoint"))
	}
}

func (s *Server) pair(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-AGRC") != "1" {
		writeJSON(w, 403, failRes("missing header"))
		return
	}
	ip := clientIP(r)
	s.fmu.Lock()
	f := s.fails[ip]
	if f == nil {
		f = &failRec{}
		s.fails[ip] = f
	}
	if s.globalFails >= 30 {
		s.fmu.Unlock()
		writeJSON(w, 429, failRes("Too many wrong PINs. Restart the bridge on the laptop to allow pairing again."))
		return
	}
	if time.Now().Before(f.until) {
		wait := int(time.Until(f.until).Seconds()) + 1
		s.fmu.Unlock()
		writeJSON(w, 429, failRes("Too many attempts. Wait "+itoa(wait)+"s."))
		return
	}
	s.fmu.Unlock()
	var body struct {
		Pin string `json:"pin"`
	}
	_ = readJSON(r, 1024, &body)
	pin := (body.Pin + "      ")[:6]
	s.cfg.mu.Lock()
	want := s.cfg.Pin
	s.cfg.mu.Unlock()
	if subtle.ConstantTimeCompare([]byte(pin), []byte(want)) != 1 {
		s.fmu.Lock()
		f.n++
		s.globalFails++
		if f.n >= 5 {
			f.until, f.n = time.Now().Add(time.Minute), 0
		}
		s.fmu.Unlock()
		log.Printf("wrong PIN from %s", ip)
		writeJSON(w, 401, failRes("Wrong PIN"))
		return
	}
	token := randHex(32)
	_ = s.cfg.Update(func(c *Config) {
		c.Sessions = append(c.Sessions, sha256hex(token))
		if len(c.Sessions) > 20 {
			c.Sessions = c.Sessions[len(c.Sessions)-20:]
		}
	})
	log.Printf("phone paired from %s", ip)
	http.SetCookie(w, &http.Cookie{Name: "agrc", Value: token, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: 31536000})
	writeJSON(w, 200, okRes())
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, 500, failRes("streaming unsupported"))
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(200)
	c := &sseClient{id: randHex(6), ch: make(chan sseMsg, 256), kill: make(chan struct{}), lite: r.URL.Query().Get("lite") == "1"}
	write := func(ev string, data []byte) bool {
		if _, err := io.WriteString(w, "event: "+ev+"\ndata: "); err != nil {
			return false
		}
		if _, err := w.Write(data); err != nil {
			return false
		}
		if _, err := io.WriteString(w, "\n\n"); err != nil {
			return false
		}
		fl.Flush()
		return true
	}
	s.cmu.Lock()
	s.clients[c.id] = c
	n := len(s.clients)
	s.cmu.Unlock()
	s.link.clients.Store(int32(n))
	s.link.ForceSnap()
	defer func() {
		s.cmu.Lock()
		delete(s.clients, c.id)
		n := len(s.clients)
		screen := c.screen
		s.cmu.Unlock()
		s.link.clients.Store(int32(n))
		if screen {
			go s.link.ScreenSubscribe(-1)
		}
	}()
	write("hello", []byte(jsJSON(map[string]string{"cid": c.id})))
	write("state", s.link.StateJSON())
	if !c.lite {
		if h, _ := s.link.CSS(); h != "" {
			write("css", []byte(jsJSON(map[string]string{"hash": h})))
		}
		if b := s.link.SnapJSON(); b != nil {
			write("snap", b)
		}
		write("overlays", s.link.OverlaysJSON())
	}
	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()
	for {
		select {
		case m := <-c.ch:
			if !write(m.event, m.data) {
				return
			}
		case <-ping.C:
			if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
				return
			}
			fl.Flush()
		case <-c.kill:
			return
		case <-r.Context().Done():
			return
		}
	}
}

func (s *Server) post(w http.ResponseWriter, r *http.Request, p string) {
	reply := func(res Result, err error) {
		if err != nil {
			writeJSON(w, 200, failRes(err.Error()))
			return
		}
		writeJSON(w, 200, res)
	}
	switch p {
	case "/api/send":
		var b struct {
			Text string `json:"text"`
		}
		if readJSON(r, 1<<20, &b) != nil {
			writeJSON(w, 400, failRes("bad JSON"))
			return
		}
		reply(s.link.SendMessage(b.Text))
	case "/api/click":
		var b ClickRef
		if readJSON(r, 64<<10, &b) != nil {
			writeJSON(w, 400, failRes("bad JSON"))
			return
		}
		reply(s.link.Click(b))
	case "/api/key":
		var b struct {
			Key  string `json:"key"`
			Mods Mods   `json:"mods"`
		}
		if readJSON(r, 4096, &b) != nil {
			writeJSON(w, 400, failRes("bad JSON"))
			return
		}
		reply(s.link.Key(b.Key, b.Mods))
	case "/api/type":
		var b struct {
			Text string `json:"text"`
		}
		if readJSON(r, 1<<20, &b) != nil {
			writeJSON(w, 400, failRes("bad JSON"))
			return
		}
		reply(s.link.TypeText(b.Text))
	case "/api/stop":
		reply(s.link.Stop())
	case "/api/refresh":
		s.link.ForceSnap()
		_ = s.link.RefreshCSS()
		writeJSON(w, 200, okRes())
	case "/api/target":
		var b struct {
			ID string `json:"id"`
		}
		_ = readJSON(r, 4096, &b)
		s.link.Pin(b.ID)
		s.link.ForceSnap()
		s.link.discover()
		writeJSON(w, 200, okRes())
	case "/api/selectors":
		var b struct {
			Input string `json:"input"`
			Panel string `json:"panel"`
		}
		_ = readJSON(r, 8192, &b)
		sel := map[string]string{}
		if strings.TrimSpace(b.Input) != "" {
			sel["input"] = strings.TrimSpace(b.Input)
		}
		if strings.TrimSpace(b.Panel) != "" {
			sel["panel"] = strings.TrimSpace(b.Panel)
		}
		_ = s.cfg.Update(func(c *Config) { c.Selectors = sel })
		s.link.ForceSnap()
		writeJSON(w, 200, Result{"ok": true, "selectors": sel})
	case "/api/settings":
		var b struct {
			PollMs int `json:"pollMs"`
		}
		_ = readJSON(r, 4096, &b)
		if b.PollMs >= 250 && b.PollMs <= 5000 {
			_ = s.cfg.Update(func(c *Config) { c.PollMs = b.PollMs })
		}
		writeJSON(w, 200, okRes())
	case "/api/screen":
		var b struct {
			CID string `json:"cid"`
			On  bool   `json:"on"`
		}
		_ = readJSON(r, 4096, &b)
		s.cmu.Lock()
		c := s.clients[b.CID]
		changed := c != nil && c.screen != b.On
		if changed {
			c.screen = b.On
		}
		s.cmu.Unlock()
		if c == nil {
			writeJSON(w, 400, failRes("unknown client"))
			return
		}
		if changed {
			d := -1
			if b.On {
				d = 1
			}
			s.link.ScreenSubscribe(d)
		}
		writeJSON(w, 200, okRes())
	case "/api/screen/tap":
		var b struct {
			X, Y          float64
			Right, Double bool
		}
		_ = readJSON(r, 4096, &b)
		reply(s.link.ScreenTap(b.X, b.Y, b.Right, b.Double))
	case "/api/screen/scroll":
		var b struct{ X, Y, Dy float64 }
		_ = readJSON(r, 4096, &b)
		reply(s.link.ScreenScroll(b.X, b.Y, b.Dy))
	case "/api/ws":
		var b struct {
			Add    string `json:"add"`
			Remove *int   `json:"remove"`
		}
		_ = readJSON(r, 8192, &b)
		if b.Add != "" {
			wp, _ := filepath.Abs(b.Add)
			if st, err := os.Stat(wp); err != nil || !st.IsDir() {
				writeJSON(w, 400, failRes("folder does not exist on the laptop"))
				return
			}
			_ = s.cfg.Update(func(c *Config) {
				if !contains(c.Workspaces, wp) {
					c.Workspaces = append(c.Workspaces, wp)
				}
			})
		}
		if b.Remove != nil {
			_ = s.cfg.Update(func(c *Config) {
				if *b.Remove >= 0 && *b.Remove < len(c.Workspaces) {
					c.Workspaces = append(c.Workspaces[:*b.Remove], c.Workspaces[*b.Remove+1:]...)
				}
			})
		}
		writeJSON(w, 200, Result{"ok": true, "workspaces": s.cfg.WorkspacesCopy()})
	case "/api/fs/write":
		var b struct {
			W         json.Number `json:"w"`
			P         string      `json:"p"`
			Content   *string     `json:"content"`
			BaseMtime *float64    `json:"baseMtime"`
		}
		if readJSON(r, 8<<20, &b) != nil || b.Content == nil {
			writeJSON(w, 400, failRes("bad JSON"))
			return
		}
		writeJSON(w, 200, fsWrite(s.cfg, b.W.String(), b.P, *b.Content, b.BaseMtime))
	default:
		writeJSON(w, 404, failRes("unknown endpoint"))
	}
}

func init() { _ = mime.AddExtensionType(".webmanifest", "application/manifest+json") }
