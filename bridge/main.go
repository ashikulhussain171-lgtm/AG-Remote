// AGRemote-Bridge: lets the Antigravity Remote phone app control Google Antigravity on this computer.
package main

import (
	"bufio"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"
)

var version = "1.1.0"

const usage = `AGRemote-Bridge %s — control Antigravity from your phone

Usage: AGRemote-Bridge [options]
  --workspace <dir>     project folder for the Code/Git tab (repeatable, remembered)
  --cdp-port <n>        Antigravity --remote-debugging-port (default 9000)
  --port <n>            port the phone connects to (default 8787)
  --bind <ip>           interface to listen on (default 0.0.0.0)
  --ag-exe <path>       Antigravity executable / .app (auto-detected if omitted)
  --no-launch           do not start or restart Antigravity
  --history-root <dir>  override history folder (default ~/.gemini/antigravity*)
  --new-pin             generate a new pairing PIN
  --reset-sessions      log out all paired phones
  --config <file>       config file (default ~/.ag-remote/config.json)
`

func pauseExit(code int) {
	if interactive() {
		fmt.Print("\nEnter dabao band karne ke liye…")
		_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
	}
	os.Exit(code)
}

func lanIPs() []string {
	out := []string{}
	ifaces, _ := net.Interfaces()
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok || ipn.IP.To4() == nil || ipn.IP.IsLinkLocalUnicast() {
				continue
			}
			out = append(out, ipn.IP.String())
		}
	}
	// Private LAN ranges first, Tailscale (100.x) next, the rest last.
	rank := func(ip string) int {
		switch {
		case strings.HasPrefix(ip, "192.168."), strings.HasPrefix(ip, "10."):
			return 0
		case strings.HasPrefix(ip, "172."):
			return 1
		case strings.HasPrefix(ip, "100."):
			return 2
		}
		return 3
	}
	sort.SliceStable(out, func(i, j int) bool { return rank(out[i]) < rank(out[j]) })
	return out
}

func main() {
	log.SetFlags(log.Ltime)
	args, err := parseArgs(os.Args[1:])
	if err != nil {
		fmt.Println(err)
		pauseExit(2)
	}
	if args.Help {
		fmt.Printf(usage, version)
		return
	}
	cfg, err := loadConfig(args)
	if err != nil {
		fmt.Println("Config error:", err)
		pauseExit(1)
	}

	fmt.Printf("\n  Antigravity Remote bridge %s\n  Config: %s\n\n", version, cfg.file)
	if !args.NoLaunch {
		ensureAntigravity(cfg)
	}

	srv := NewServer(cfg)
	ln, err := net.Listen("tcp", fmt.Sprintf("%s:%d", cfg.Bind, cfg.Port))
	if err != nil {
		fmt.Printf("\n  ✖ Port %d par start nahi hua: %v\n  Shayad bridge pehle se chal raha hai. Ya --port 8788 try karo.\n", cfg.Port, err)
		pauseExit(1)
	}
	ips := lanIPs()
	if len(ips) == 0 {
		ips = []string{"127.0.0.1"}
	}
	fmt.Println("\n  ───────────────────────────────────────────────")
	fmt.Println("  Phone app mein yeh address daalo (same Wi-Fi):")
	for _, ip := range ips {
		fmt.Printf("     %s:%d\n", ip, cfg.Port)
	}
	fmt.Printf("\n  Pairing PIN:  %s\n", cfg.Pin)
	fmt.Println("  ───────────────────────────────────────────────")
	if len(cfg.WorkspacesCopy()) == 0 {
		fmt.Println("  Tip: Code tab ke liye phone app ke Code tab mein + dabake project folder add karo.")
	}
	fmt.Println("  Yeh window khuli rakho. Band karne par phone control ruk jayega.")
	fmt.Println()

	srv.link.Start()
	hs := &http.Server{Handler: srv, ReadHeaderTimeout: 10 * time.Second}
	if err := hs.Serve(ln); err != nil {
		fmt.Println("server error:", err)
		pauseExit(1)
	}
}
