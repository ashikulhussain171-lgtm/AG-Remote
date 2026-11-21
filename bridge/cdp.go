package main

// Chrome DevTools Protocol session over the minimal WebSocket client.

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

type Target struct {
	ID                   string `json:"id"`
	Type                 string `json:"type"`
	Title                string `json:"title"`
	URL                  string `json:"url"`
	WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
}

var localHTTP = &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{Proxy: nil}}

func getJSON(host string, port int, path string, out any) error {
	resp, err := localHTTP.Get(fmt.Sprintf("http://%s:%d%s", host, port, path))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func listTargets(host string, port int) ([]Target, error) {
	var t []Target
	err := getJSON(host, port, "/json/list", &t)
	return t, err
}

type cdpResp struct {
	result json.RawMessage
	err    error
}

type CDP struct {
	ws        *wsConn
	target    Target
	nextID    atomic.Int64
	mu        sync.Mutex
	pending   map[int64]chan cdpResp
	lmu       sync.Mutex
	listeners map[string][]func(json.RawMessage)
	onClose   []func()
	closed    atomic.Bool
}

func cdpConnect(t Target) (*CDP, error) {
	if t.WebSocketDebuggerURL == "" {
		return nil, errors.New("target has no webSocketDebuggerUrl (already attached by DevTools?)")
	}
	ws, err := wsDial(t.WebSocketDebuggerURL, 4*time.Second)
	if err != nil {
		return nil, err
	}
	s := &CDP{ws: ws, target: t, pending: map[int64]chan cdpResp{}, listeners: map[string][]func(json.RawMessage){}}
	go s.readLoop()
	return s, nil
}

func (s *CDP) readLoop() {
	for {
		data, err := s.ws.ReadMessage()
		if err != nil {
			s.Close()
			return
		}
		var m struct {
			ID     int64           `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Message string `json:"message"`
				Data    string `json:"data"`
			} `json:"error"`
		}
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		if m.ID != 0 {
			s.mu.Lock()
			ch := s.pending[m.ID]
			delete(s.pending, m.ID)
			s.mu.Unlock()
			if ch != nil {
				if m.Error != nil {
					msg := m.Error.Message
					if m.Error.Data != "" {
						msg += ": " + m.Error.Data
					}
					ch <- cdpResp{err: errors.New(msg)}
				} else {
					ch <- cdpResp{result: m.Result}
				}
			}
		} else if m.Method != "" {
			s.lmu.Lock()
			fns := append([]func(json.RawMessage){}, s.listeners[m.Method]...)
			s.lmu.Unlock()
			for _, fn := range fns {
				fn(m.Params)
			}
		}
	}
}

func (s *CDP) Close() {
	if s.closed.Swap(true) {
		return
	}
	s.ws.Close()
	s.mu.Lock()
	for id, ch := range s.pending {
		ch <- cdpResp{err: errors.New("CDP session closed")}
		delete(s.pending, id)
	}
	s.mu.Unlock()
	s.lmu.Lock()
	fns := s.onClose
	s.lmu.Unlock()
	for _, fn := range fns {
		fn()
	}
}

func (s *CDP) Closed() bool { return s.closed.Load() }

func (s *CDP) OnClose(fn func()) {
	s.lmu.Lock()
	s.onClose = append(s.onClose, fn)
	s.lmu.Unlock()
}

func (s *CDP) On(method string, fn func(json.RawMessage)) {
	s.lmu.Lock()
	s.listeners[method] = append(s.listeners[method], fn)
	s.lmu.Unlock()
}

func (s *CDP) Send(method string, params any, timeout time.Duration) (json.RawMessage, error) {
	if s.closed.Load() {
		return nil, errors.New("CDP session closed")
	}
	if params == nil {
		params = map[string]any{}
	}
	id := s.nextID.Add(1)
	ch := make(chan cdpResp, 1)
	s.mu.Lock()
	s.pending[id] = ch
	s.mu.Unlock()
	b, _ := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
	if err := s.ws.WriteText(b); err != nil {
		s.mu.Lock()
		delete(s.pending, id)
		s.mu.Unlock()
		s.Close()
		return nil, err
	}
	select {
	case r := <-ch:
		return r.result, r.err
	case <-time.After(timeout):
		s.mu.Lock()
		delete(s.pending, id)
		s.mu.Unlock()
		return nil, fmt.Errorf("CDP %s timeout", method)
	}
}

// EvalJSON evaluates an expression that returns a JSON string and decodes it into out.
func (s *CDP) EvalJSON(expr string, out any, timeout time.Duration) error {
	raw, err := s.Send("Runtime.evaluate", map[string]any{"expression": expr, "returnByValue": true, "awaitPromise": true, "userGesture": true}, timeout)
	if err != nil {
		return err
	}
	var r struct {
		Result struct {
			Type  string          `json:"type"`
			Value json.RawMessage `json:"value"`
		} `json:"result"`
		ExceptionDetails *struct {
			Text      string `json:"text"`
			Exception struct {
				Description string `json:"description"`
			} `json:"exception"`
		} `json:"exceptionDetails"`
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return err
	}
	if r.ExceptionDetails != nil {
		d := r.ExceptionDetails.Exception.Description
		if d == "" {
			d = r.ExceptionDetails.Text
		}
		return fmt.Errorf("page exception: %s", d)
	}
	if r.Result.Type != "string" {
		return fmt.Errorf("page returned %s instead of JSON text", r.Result.Type)
	}
	var str string
	if err := json.Unmarshal(r.Result.Value, &str); err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal([]byte(str), out)
}
