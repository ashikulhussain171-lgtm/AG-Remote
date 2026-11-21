# AG Remote — phone se laptop ka Antigravity control 📱➜💻

```
AG Remote APK (phone)  ──Wi-Fi / Tailscale──►  AGRemote-Bridge.exe (laptop)  ──CDP 127.0.0.1:9000──►  Antigravity
```

## Laptop: AGRemote-Bridge.exe
Kuch install nahi karna (Node, Python kuch nahi). Ek hi file hai.

1. `AGRemote-Bridge.exe` ko kisi folder mein rakho aur double-click karo.
2. Exe Antigravity khud dhoondhta hai aur use `--remote-debugging-port=9000` ke saath kholta hai.
   - Antigravity pehle se khula ho to exe poochhega: "band karke dobara kholun? [y/N]". `y` dabao (pehle unsaved kaam save kar lo).
   - Antigravity na mile: `AGRemote-Bridge.exe --ag-exe "C:\...\Antigravity.exe"` (path ek baar yaad rakha jata hai).
3. Window mein **address** (jaise `192.168.1.5:8787`) aur **6-digit PIN** dikhega. Yeh window khuli rakho.
4. Windows Firewall poochhe to **Private networks → Allow** karo.
5. Windows SmartScreen "unknown publisher" bole to **More info → Run anyway** (exe sign nahi hai).

Options: `--workspace "C:\project"` (Code tab), `--port 8787`, `--cdp-port 9000`, `--no-launch`, `--new-pin`, `--reset-sessions`, `--help`.
Config: `%USERPROFILE%\.ag-remote\config.json`.

macOS / Linux ke liye `AGRemote-Bridge-mac-arm64`, `-mac-intel`, `-linux` binaries bhi bante hain (GitHub Actions se).

## Phone: AG Remote APK
1. APK install karo ("Install unknown apps" allow karna padega).
2. App khulte hi **Wi-Fi par laptop dhoondo** — laptop list mein aayega, tap karo. (Ya address khud daalo.)
3. PIN daalo. Bas — Chat, Screen, History, Code, Settings tabs.
4. Settings → **Background alerts** on karo: app band ho tab bhi "Approval chahiye" / "Kaam khatam" notification aayega.
5. Settings → **Laptop badlo** se doosra laptop chuno.

APK ke bina bhi chalta hai: phone ke Chrome mein `http://<laptop-ip>:8787` kholo.

### APK build kaise hota hai (GitHub Actions)
Ye poora folder ek GitHub repo mein push karo. `.github/workflows/build.yml` har push par cloud mein build karta hai:
- `AG-Remote.apk` (phone)
- `AGRemote-Bridge.exe` + mac/linux binaries (laptop)

Build ke baad repo ke **Releases → latest** se phone par seedha download karo.
Android Studio se bhi khul jata hai: `android/` folder open karo → Build → Build APK.

APK hamesha `android/app/agremote.keystore` se sign hota hai, isliye har nayi build purani app ke upar update ki tarah install hogi. Yeh key sirf personal use ke liye hai — repo private rakho.

## Tabs
| Tab | Kya karta hai |
|---|---|
| **Chat** | Agent panel ka live mirror. Message bhejo, ■ Stop. Upar chips = panel ke buttons (New chat, History, model, mode). Accept/Reject/Run neeche bade buttons + vibrate. Mirror mein tap = laptop par real click. Menu khule to neeche sheet. `Text` mode = plain text. |
| **Screen** | Antigravity window ki live video. Tap/Right/Double/Scroll, typing, shortcuts (Ctrl/⌘+S, Ctrl+Shift+P, Esc…). Jo mirror mein na dikhe, yahan se control karo. |
| **History** | `~/.gemini/antigravity*/brain/...` ki conversations: title, transcript, artifacts (task.md, plan, walkthrough, screenshots). |
| **Code** | Workspace files browse/edit/save (conflict check ke saath), git status + coloured diff. |
| **Settings** | Window chunna, Diagnostics, selector override, refresh speed, background alerts, laptop badlo, logout. |

## Problem ho to
- **"Debug port band hai"** → Antigravity flag ke bina chal raha hai. Use band karke exe dobara chalao. Check: laptop browser mein `http://127.0.0.1:9000/json/version` khulna chahiye.
- **"Agent chat nahi mila"** → Antigravity mein Agent panel / Agent Manager khula rakho; Settings → windows mein sahi window chuno.
- **Message galat jagah / nahi jaata** → Settings → Run diagnostics → sahi candidate par *Use this input*. Na chale to *Raw JSON* copy karke bhejo.
- **APK laptop nahi dhoondh pa raha** → same Wi-Fi? Firewall allow? Address manually daalo (bridge window mein likha hai).

## Security
- 6-digit PIN pairing, galat PIN par rate limit (5/min per IP; 30 total ke baad bridge restart tak pairing band).
- Paired phone ko 1 saal ki HttpOnly cookie; `--reset-sessions` se sab logout.
- Code tab sirf diye gaye workspace folders ke andar; history sirf `.gemini/antigravity*` ke andar.
- Antigravity ka debug port sirf `127.0.0.1` par. Bridge port (8787) ko router par public forward mat karo — bahar se Tailscale use karo.

## Code layout
- `bridge/` — Go (sirf standard library): `ws.go` WebSocket client, `cdp.go` DevTools protocol, `agent.go` mirror/send/click/screen, `history.go`, `files.go`, `server.go` HTTP + SSE + pairing, `launch.go` Antigravity dhoondhna/kholna, `pagelib.js` (Antigravity window ke andar chalne wala script), `web/` phone UI (exe ke andar embed).
- `android/` — Java WebView app: `MainActivity.java` (setup + LAN discovery + WebView), `AlertService.java` (background notifications), `assets/setup.html`.
- Build: `cd bridge && GOOS=windows GOARCH=amd64 go build -o AGRemote-Bridge.exe .`
