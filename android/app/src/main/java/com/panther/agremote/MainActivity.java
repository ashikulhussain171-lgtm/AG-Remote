package com.panther.agremote;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.TextUtils;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/**
 * Hosts the Antigravity Remote web app served by the laptop bridge, plus a local setup
 * screen that finds the bridge on the Wi-Fi. Background approval alerts live in AlertService.
 */
public class MainActivity extends Activity {
    static final String PREFS = "agrc";
    static final int DEFAULT_PORT = 8787;
    static volatile boolean visible;

    private WebView web;
    private SharedPreferences prefs;
    private volatile boolean scanning;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        web = new WebView(this);
        web.setBackgroundColor(0xFF0D0F17);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100);
        s.setSupportZoom(false);
        CookieManager.getInstance().setAcceptCookie(true);

        web.addJavascriptInterface(new NativeBridge(), "AGRCNative");
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if ("file".equals(u.getScheme())) return false;
                String hostPort = u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
                if (hostPort.equals(prefs.getString("server", ""))) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (url != null && url.startsWith("http")) saveCookie(url);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame() && !"file".equals(request.getUrl().getScheme())) {
                    showSetup("Laptop se connect nahi hua (" + error.getDescription()
                            + "). Laptop par AGRemote-Bridge chal raha hai? Dono same Wi-Fi par hain?");
                }
            }
        });

        String server = prefs.getString("server", null);
        if (server == null) showSetup(null);
        else openServer(server);

        if (prefs.getBoolean("alerts", false)) startAlerts();
    }

    @Override
    protected void onResume() {
        super.onResume();
        visible = true;
    }

    @Override
    protected void onPause() {
        visible = false;
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    public void onBackPressed() {
        String url = web.getUrl();
        if (url != null && url.startsWith("http")) {
            moveTaskToBack(true); // keep the live connection instead of closing the app
        } else {
            super.onBackPressed();
        }
    }

    private void saveCookie(String url) {
        String c = CookieManager.getInstance().getCookie(url);
        if (c != null) prefs.edit().putString("cookie", c).apply();
        CookieManager.getInstance().flush();
    }

    private void showSetup(String message) {
        String url = "file:///android_asset/setup.html";
        if (message != null) url += "#" + Uri.encode(message);
        web.loadUrl(url);
    }

    private void openServer(String server) {
        web.loadUrl("http://" + server + "/");
    }

    static String normalize(String input) {
        String v = input == null ? "" : input.trim();
        if (v.startsWith("http://")) v = v.substring(7);
        if (v.startsWith("https://")) v = v.substring(8);
        while (v.endsWith("/")) v = v.substring(0, v.length() - 1);
        if (!v.isEmpty() && !v.contains(":")) v = v + ":" + DEFAULT_PORT;
        return v;
    }

    private void setAlerts(boolean on) {
        prefs.edit().putBoolean("alerts", on).apply();
        if (on) {
            if (Build.VERSION.SDK_INT >= 33
                    && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 7);
            }
            String url = web.getUrl();
            if (url != null && url.startsWith("http")) saveCookie(url);
            startAlerts();
        } else {
            stopService(new Intent(this, AlertService.class));
        }
    }

    private void startAlerts() {
        Intent i = new Intent(this, AlertService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
            else startService(i);
        } catch (Exception e) {
            prefs.edit().putBoolean("alerts", false).apply();
        }
    }

    private void js(final String code) {
        runOnUiThread(() -> web.evaluateJavascript(code, null));
    }

    // ---------------- LAN discovery: probe every host of our /24 subnets for /api/ping ----------------

    private void scan() {
        scanning = true;
        List<String> prefixes = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address && a.isSiteLocalAddress()) {
                        String ip = a.getHostAddress();
                        String pre = ip.substring(0, ip.lastIndexOf('.') + 1);
                        if (!prefixes.contains(pre)) prefixes.add(pre);
                    }
                }
            }
        } catch (Exception ignored) {
        }
        ExecutorService pool = Executors.newFixedThreadPool(48);
        List<Future<?>> jobs = new ArrayList<>();
        for (String pre : prefixes) {
            for (int i = 1; i < 255; i++) {
                final String host = pre + i;
                jobs.add(pool.submit(() -> probe(host, DEFAULT_PORT)));
            }
        }
        for (Future<?> f : jobs) {
            try {
                f.get();
            } catch (Exception ignored) {
            }
        }
        pool.shutdown();
        scanning = false;
        js("window.onScanDone && window.onScanDone(" + JSONObject.quote(TextUtils.join(", ", prefixes)) + ")");
    }

    private void probe(String host, int port) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL("http://" + host + ":" + port + "/api/ping").openConnection();
            c.setConnectTimeout(700);
            c.setReadTimeout(1000);
            if (c.getResponseCode() != 200) return;
            JSONObject o = new JSONObject(readAll(c.getInputStream(), 4096));
            if (!"antigravity-remote".equals(o.optString("app"))) return;
            JSONObject r = new JSONObject();
            r.put("addr", host + ":" + port);
            r.put("host", o.optString("host"));
            js("window.onFound && window.onFound(" + r + ")");
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.disconnect();
        }
    }

    static String readAll(InputStream in, int max) throws java.io.IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[2048];
        int n;
        while ((n = in.read(buf)) > 0 && out.size() < max) out.write(buf, 0, n);
        in.close();
        return out.toString("UTF-8");
    }

    /** Methods callable from page JavaScript as window.AGRCNative.* */
    class NativeBridge {
        @JavascriptInterface
        public String getServer() {
            return prefs.getString("server", "");
        }

        @JavascriptInterface
        public void connect(String hostPort) {
            final String v = normalize(hostPort);
            if (v.isEmpty()) return;
            prefs.edit().putString("server", v).apply();
            runOnUiThread(() -> openServer(v));
        }

        @JavascriptInterface
        public void changeServer() {
            runOnUiThread(() -> showSetup(null));
        }

        @JavascriptInterface
        public boolean alertsOn() {
            return prefs.getBoolean("alerts", false);
        }

        @JavascriptInterface
        public void setAlerts(final boolean on) {
            runOnUiThread(() -> MainActivity.this.setAlerts(on));
        }

        @JavascriptInterface
        public void discover() {
            if (!scanning) new Thread(MainActivity.this::scan, "agrc-scan").start();
        }
    }
}
