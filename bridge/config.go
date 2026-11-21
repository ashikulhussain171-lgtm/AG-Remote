package main

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"strconv"
	"sync"
)

type Config struct {
	Port          int               `json:"port"`
	Bind          string            `json:"bind"`
	CDPHost       string            `json:"cdpHost"`
	CDPPort       int               `json:"cdpPort"`
	PollMs        int               `json:"pollMs"`
	ScreenQuality int               `json:"screenQuality"`
	Pin           string            `json:"pin"`
	Sessions      []string          `json:"sessions"`
	Workspaces    []string          `json:"workspaces"`
	HistoryRoots  []string          `json:"historyRoots"`
	Selectors     map[string]string `json:"selectors"`
	AgExe         string            `json:"agExe"`

	historyRootsRuntime []string
	mu                  sync.Mutex
	file                string
}

type Args struct {
	Port, CDPPort                         int
	Bind, CDPHost, ConfigFile, AgExe      string
	Workspaces, HistoryRoots              []string
	NewPin, ResetSessions, Help, NoLaunch bool
}

func parseArgs(argv []string) (Args, error) {
	a := Args{}
	next := func(i *int, name string) (string, error) {
		if *i+1 >= len(argv) {
			return "", fmt.Errorf("%s needs a value", name)
		}
		*i++
		return argv[*i], nil
	}
	for i := 0; i < len(argv); i++ {
		k := argv[i]
		var v string
		var err error
		switch k {
		case "--port", "--cdp-port":
			if v, err = next(&i, k); err != nil {
				return a, err
			}
			n, e := strconv.Atoi(v)
			if e != nil || n <= 0 || n > 65535 {
				return a, fmt.Errorf("%s: bad port %q", k, v)
			}
			if k == "--port" {
				a.Port = n
			} else {
				a.CDPPort = n
			}
		case "--bind":
			a.Bind, err = next(&i, k)
		case "--cdp-host":
			a.CDPHost, err = next(&i, k)
		case "--config":
			a.ConfigFile, err = next(&i, k)
		case "--ag-exe":
			a.AgExe, err = next(&i, k)
		case "--workspace", "-w":
			if v, err = next(&i, k); err == nil {
				p, _ := filepath.Abs(v)
				a.Workspaces = append(a.Workspaces, p)
			}
		case "--history-root":
			if v, err = next(&i, k); err == nil {
				p, _ := filepath.Abs(v)
				a.HistoryRoots = append(a.HistoryRoots, p)
			}
		case "--new-pin":
			a.NewPin = true
		case "--reset-sessions":
			a.ResetSessions = true
		case "--no-launch":
			a.NoLaunch = true
		case "--help", "-h", "/?":
			a.Help = true
		default:
			return a, fmt.Errorf("unknown option %q (use --help)", k)
		}
		if err != nil {
			return a, err
		}
	}
	return a, nil
}

func newPin() string {
	n, _ := rand.Int(rand.Reader, big.NewInt(1000000))
	return fmt.Sprintf("%06d", n.Int64())
}

func loadConfig(a Args) (*Config, error) {
	file := a.ConfigFile
	if file == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		file = filepath.Join(home, ".ag-remote", "config.json")
	}
	c := &Config{Port: 8787, Bind: "0.0.0.0", CDPHost: "127.0.0.1", CDPPort: 9000, PollMs: 700, ScreenQuality: 60, Selectors: map[string]string{}}
	if b, err := os.ReadFile(file); err == nil {
		if err := json.Unmarshal(b, c); err != nil {
			return nil, fmt.Errorf("config %s is not valid JSON: %v", file, err)
		}
	}
	c.file = file
	if c.Selectors == nil {
		c.Selectors = map[string]string{}
	}
	if c.Pin == "" || len(c.Pin) != 6 || a.NewPin {
		c.Pin = newPin()
	}
	if a.ResetSessions {
		c.Sessions = nil
	}
	if a.Port != 0 {
		c.Port = a.Port
	}
	if a.CDPPort != 0 {
		c.CDPPort = a.CDPPort
	}
	if a.Bind != "" {
		c.Bind = a.Bind
	}
	if a.CDPHost != "" {
		c.CDPHost = a.CDPHost
	}
	if a.AgExe != "" {
		c.AgExe = a.AgExe
	}
	for _, w := range a.Workspaces {
		if !contains(c.Workspaces, w) {
			c.Workspaces = append(c.Workspaces, w)
		}
	}
	if len(a.HistoryRoots) > 0 {
		c.historyRootsRuntime = a.HistoryRoots
	}
	return c, c.Save()
}

func (c *Config) Save() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.saveLocked()
}

func (c *Config) saveLocked() error {
	if err := os.MkdirAll(filepath.Dir(c.file), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	tmp := c.file + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, c.file)
}

// Update runs fn with the config locked and saves afterwards.
func (c *Config) Update(fn func(c *Config)) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	fn(c)
	return c.saveLocked()
}

// Snapshot helpers for values read concurrently.
func (c *Config) WorkspacesCopy() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string{}, c.Workspaces...)
}

func (c *Config) SelectorsCopy() map[string]string {
	c.mu.Lock()
	defer c.mu.Unlock()
	m := map[string]string{}
	for k, v := range c.Selectors {
		m[k] = v
	}
	return m
}

func (c *Config) Poll() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.PollMs
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
