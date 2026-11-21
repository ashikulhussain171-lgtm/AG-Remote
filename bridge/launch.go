package main

// Finds Antigravity, and (re)starts it with --remote-debugging-port so the bridge can attach.
// Install paths below are common defaults, not measured on every machine; --ag-exe overrides.

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func debugPortUp(c *Config) bool {
	var v map[string]any
	return getJSON(c.CDPHost, c.CDPPort, "/json/version", &v) == nil
}

func interactive() bool {
	st, err := os.Stdin.Stat()
	return err == nil && st.Mode()&os.ModeCharDevice != 0
}

func ask(q string) string {
	fmt.Print(q)
	line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	return strings.TrimSpace(strings.ToLower(line))
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// runningAntigravity returns executable paths of running Antigravity processes (may be empty strings if unknown).
func runningAntigravity() []string {
	switch runtime.GOOS {
	case "windows":
		cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
			"Get-Process | Where-Object { $_.ProcessName -like 'Antigravity*' } | ForEach-Object { if ($_.Path) { $_.Path } else { $_.ProcessName } } | Select-Object -Unique")
		hideWindow(cmd)
		out, err := cmd.Output()
		if err != nil {
			return nil
		}
		return nonEmptyLines(string(out))
	case "darwin":
		out, _ := exec.Command("pgrep", "-fl", "Antigravity.*\\.app/Contents/MacOS/").Output()
		return nonEmptyLines(string(out))
	default:
		out, _ := exec.Command("pgrep", "-fa", "[Aa]ntigravity").Output()
		res := []string{}
		self, _ := os.Executable()
		for _, l := range nonEmptyLines(string(out)) {
			if !strings.Contains(l, filepath.Base(self)) {
				res = append(res, l)
			}
		}
		return res
	}
}

func nonEmptyLines(s string) []string {
	out := []string{}
	for _, l := range strings.Split(strings.ReplaceAll(s, "\r", ""), "\n") {
		if strings.TrimSpace(l) != "" {
			out = append(out, strings.TrimSpace(l))
		}
	}
	return out
}

func findAntigravity(c *Config, running []string) string {
	if c.AgExe != "" && (fileExists(c.AgExe) || strings.HasSuffix(c.AgExe, ".app")) {
		return c.AgExe
	}
	switch runtime.GOOS {
	case "windows":
		for _, r := range running {
			if strings.HasSuffix(strings.ToLower(r), ".exe") && fileExists(r) {
				return r
			}
		}
		la, pf := os.Getenv("LOCALAPPDATA"), os.Getenv("ProgramFiles")
		cands := []string{
			filepath.Join(la, "Programs", "Antigravity", "Antigravity.exe"),
			filepath.Join(la, "Programs", "Antigravity IDE", "Antigravity IDE.exe"),
			filepath.Join(pf, "Antigravity", "Antigravity.exe"),
			filepath.Join(pf, "Google", "Antigravity", "Antigravity.exe"),
		}
		for _, p := range cands {
			if fileExists(p) {
				return p
			}
		}
		if m, _ := filepath.Glob(filepath.Join(la, "Programs", "*", "Antigravity*.exe")); len(m) > 0 {
			return m[0]
		}
	case "darwin":
		home, _ := os.UserHomeDir()
		for _, p := range []string{"/Applications/Antigravity.app", "/Applications/Antigravity IDE.app", filepath.Join(home, "Applications", "Antigravity.app")} {
			if st, err := os.Stat(p); err == nil && st.IsDir() {
				return p
			}
		}
	default:
		if p, err := exec.LookPath("antigravity"); err == nil {
			return p
		}
		for _, p := range []string{"/usr/share/antigravity/antigravity", "/opt/Antigravity/antigravity", "/opt/antigravity/antigravity"} {
			if fileExists(p) {
				return p
			}
		}
	}
	return ""
}

func closeAntigravity(exe string) {
	switch runtime.GOOS {
	case "windows":
		name := filepath.Base(exe)
		if !strings.HasSuffix(strings.ToLower(name), ".exe") {
			name = "Antigravity.exe"
		}
		cmd := exec.Command("taskkill", "/IM", name)
		hideWindow(cmd)
		_ = cmd.Run()
	case "darwin":
		app := strings.TrimSuffix(filepath.Base(exe), ".app")
		_ = exec.Command("osascript", "-e", fmt.Sprintf(`quit app "%s"`, app)).Run()
	default:
		_ = exec.Command("pkill", "-TERM", "-x", filepath.Base(exe)).Run()
	}
}

func launchAntigravity(exe string, port int) error {
	flag := fmt.Sprintf("--remote-debugging-port=%d", port)
	if runtime.GOOS == "darwin" {
		return exec.Command("open", "-na", exe, "--args", flag).Run()
	}
	cmd := exec.Command(exe, flag)
	detach(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// ensureAntigravity makes sure Antigravity runs with the debug port. It never force-kills:
// a running instance is closed only after the user agrees, using a normal close request.
func ensureAntigravity(c *Config) {
	if debugPortUp(c) {
		fmt.Printf("  ✔ Antigravity debug port %d already open.\n", c.CDPPort)
		return
	}
	running := runningAntigravity()
	exe := findAntigravity(c, running)
	if exe == "" {
		fmt.Println("  ✖ Antigravity was not found. Give the path:  AGRemote-Bridge --ag-exe \"C:\\...\\Antigravity.exe\"")
		fmt.Printf("    Or start Antigravity yourself with: --remote-debugging-port=%d\n", c.CDPPort)
		return
	}
	if c.AgExe != exe {
		_ = c.Update(func(c *Config) { c.AgExe = exe })
	}
	if len(running) > 0 {
		fmt.Println("  ! Antigravity is running without the debug port.")
		if !interactive() {
			fmt.Println("    Close it completely; the bridge will wait and connect when it reopens with the port.")
			return
		}
		if a := ask("    Restart Antigravity with the debug port now? Save your work first. [y/N]: "); a != "y" && a != "yes" {
			fmt.Println("    OK. Close Antigravity yourself and run this again.")
			return
		}
		closeAntigravity(exe)
		deadline := time.Now().Add(20 * time.Second)
		for len(runningAntigravity()) > 0 && time.Now().Before(deadline) {
			time.Sleep(time.Second)
		}
		for len(runningAntigravity()) > 0 {
			fmt.Println("    Antigravity is still open (a dialog waiting?). Close it — waiting…")
			time.Sleep(3 * time.Second)
		}
	}
	fmt.Printf("  → Starting %s --remote-debugging-port=%d\n", exe, c.CDPPort)
	if err := launchAntigravity(exe, c.CDPPort); err != nil {
		fmt.Printf("  ✖ Launch failed: %v\n", err)
		return
	}
	for i := 0; i < 45; i++ {
		if debugPortUp(c) {
			fmt.Println("  ✔ Antigravity debug port open.")
			return
		}
		time.Sleep(time.Second)
	}
	fmt.Println("  ! The debug port is not open yet. The bridge keeps retrying in the background.")
}
