package main

// Minimal RFC 6455 WebSocket client, enough for the Chrome DevTools Protocol.
// Standard library only, so the bridge builds offline into one static executable.

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"
)

const wsMaxMessage = 512 << 20

type wsConn struct {
	c   net.Conn
	br  *bufio.Reader
	wmu sync.Mutex
}

func wsDial(raw string, timeout time.Duration) (*wsConn, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	if u.Scheme != "ws" {
		return nil, fmt.Errorf("unsupported websocket scheme %q", u.Scheme)
	}
	c, err := net.DialTimeout("tcp", u.Host, timeout)
	if err != nil {
		return nil, err
	}
	keyRaw := make([]byte, 16)
	_, _ = rand.Read(keyRaw)
	key := base64.StdEncoding.EncodeToString(keyRaw)
	_ = c.SetDeadline(time.Now().Add(timeout))
	req := fmt.Sprintf("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n", u.RequestURI(), u.Host, key)
	if _, err := io.WriteString(c, req); err != nil {
		c.Close()
		return nil, err
	}
	br := bufio.NewReaderSize(c, 1<<16)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		c.Close()
		return nil, err
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		c.Close()
		return nil, fmt.Errorf("websocket handshake failed: %s", resp.Status)
	}
	h := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	if resp.Header.Get("Sec-WebSocket-Accept") != base64.StdEncoding.EncodeToString(h[:]) {
		c.Close()
		return nil, errors.New("websocket handshake: bad accept key")
	}
	_ = c.SetDeadline(time.Time{})
	return &wsConn{c: c, br: br}, nil
}

func (w *wsConn) writeFrame(opcode byte, payload []byte) error {
	n := len(payload)
	hdr := make([]byte, 0, 14)
	hdr = append(hdr, 0x80|opcode)
	switch {
	case n < 126:
		hdr = append(hdr, 0x80|byte(n))
	case n <= 0xFFFF:
		hdr = append(hdr, 0x80|126, byte(n>>8), byte(n))
	default:
		hdr = append(hdr, 0x80|127)
		var b [8]byte
		binary.BigEndian.PutUint64(b[:], uint64(n))
		hdr = append(hdr, b[:]...)
	}
	var mask [4]byte
	_, _ = rand.Read(mask[:])
	hdr = append(hdr, mask[:]...)
	buf := make([]byte, len(hdr)+n)
	copy(buf, hdr)
	for i := 0; i < n; i++ {
		buf[len(hdr)+i] = payload[i] ^ mask[i&3]
	}
	w.wmu.Lock()
	defer w.wmu.Unlock()
	_ = w.c.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_, err := w.c.Write(buf)
	return err
}

func (w *wsConn) WriteText(b []byte) error { return w.writeFrame(0x1, b) }

// ReadMessage returns the next complete text/binary message, answering pings on the way.
func (w *wsConn) ReadMessage() ([]byte, error) {
	var msg []byte
	inMsg := false
	for {
		var h [2]byte
		if _, err := io.ReadFull(w.br, h[:]); err != nil {
			return nil, err
		}
		fin := h[0]&0x80 != 0
		op := h[0] & 0x0F
		masked := h[1]&0x80 != 0
		n := uint64(h[1] & 0x7F)
		switch n {
		case 126:
			var b [2]byte
			if _, err := io.ReadFull(w.br, b[:]); err != nil {
				return nil, err
			}
			n = uint64(binary.BigEndian.Uint16(b[:]))
		case 127:
			var b [8]byte
			if _, err := io.ReadFull(w.br, b[:]); err != nil {
				return nil, err
			}
			n = binary.BigEndian.Uint64(b[:])
		}
		if n > wsMaxMessage || uint64(len(msg))+n > wsMaxMessage {
			return nil, errors.New("websocket message too large")
		}
		var mask [4]byte
		if masked {
			if _, err := io.ReadFull(w.br, mask[:]); err != nil {
				return nil, err
			}
		}
		payload := make([]byte, n)
		if _, err := io.ReadFull(w.br, payload); err != nil {
			return nil, err
		}
		if masked {
			for i := range payload {
				payload[i] ^= mask[i&3]
			}
		}
		switch op {
		case 0x8:
			_ = w.writeFrame(0x8, nil)
			return nil, io.EOF
		case 0x9:
			_ = w.writeFrame(0xA, payload)
			continue
		case 0xA:
			continue
		case 0x1, 0x2:
			if inMsg {
				return nil, errors.New("websocket: new message inside fragmented message")
			}
			msg = payload
			inMsg = true
		case 0x0:
			if !inMsg {
				return nil, errors.New("websocket: unexpected continuation frame")
			}
			msg = append(msg, payload...)
		default:
			return nil, fmt.Errorf("websocket: unknown opcode %d", op)
		}
		if fin && inMsg {
			return msg, nil
		}
	}
}

func (w *wsConn) Close() error { return w.c.Close() }
