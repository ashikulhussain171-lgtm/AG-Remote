package com.panther.agremote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Foreground service that keeps a lightweight event stream (/api/events?lite=1) to the bridge
 * and posts a notification when Antigravity asks for approval or finishes working.
 */
public class AlertService extends Service {
    private static final String CH_RUN = "agrc_run";
    private static final String CH_ALERT = "agrc_alert";

    private volatile boolean running;
    private volatile HttpURLConnection conn;
    private Thread worker;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            NotificationChannel run = new NotificationChannel(CH_RUN, "Background connection", NotificationManager.IMPORTANCE_MIN);
            NotificationChannel alert = new NotificationChannel(CH_ALERT, "Approvals and status", NotificationManager.IMPORTANCE_HIGH);
            alert.enableVibration(true);
            nm.createNotificationChannel(run);
            nm.createNotificationChannel(alert);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = builder(CH_RUN)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("AG Remote")
                .setContentText("Watching Antigravity for approvals")
                .setOngoing(true)
                .setContentIntent(openApp())
                .build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        else startForeground(1, n);
        if (worker == null) {
            running = true;
            worker = new Thread(this::loop, "agrc-alerts");
            worker.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        HttpURLConnection c = conn;
        if (c != null) c.disconnect();
        if (worker != null) worker.interrupt();
        super.onDestroy();
    }

    @SuppressWarnings("deprecation")
    private Notification.Builder builder(String channel) {
        if (Build.VERSION.SDK_INT >= 26) return new Notification.Builder(this, channel);
        return new Notification.Builder(this);
    }

    private PendingIntent openApp() {
        Intent i = new Intent(this, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    @SuppressWarnings("deprecation")
    private void alert(String title, String text) {
        if (MainActivity.visible) return; // the open app already shows it
        Notification n = builder(CH_ALERT)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setAutoCancel(true)
                .setPriority(Notification.PRIORITY_HIGH)
                .setDefaults(Notification.DEFAULT_ALL)
                .setContentIntent(openApp())
                .build();
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        nm.notify(2, n);
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
        }
    }

    private void loop() {
        int prevPending = 0;
        boolean prevBusy = false;
        boolean first = true;
        while (running) {
            SharedPreferences p = getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE);
            String server = p.getString("server", null);
            String cookie = p.getString("cookie", null);
            if (server == null) {
                sleep(5000);
                continue;
            }
            try {
                HttpURLConnection c = (HttpURLConnection) new URL("http://" + server + "/api/events?lite=1").openConnection();
                conn = c;
                c.setConnectTimeout(5000);
                c.setReadTimeout(45000); // bridge sends a ping every 15 s
                c.setRequestProperty("Accept", "text/event-stream");
                if (cookie != null) c.setRequestProperty("Cookie", cookie);
                if (c.getResponseCode() != 200) { // 401 = this phone is not paired yet
                    c.disconnect();
                    sleep(15000);
                    continue;
                }
                BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"));
                String line;
                String event = null;
                while (running && (line = r.readLine()) != null) {
                    if (line.startsWith("event: ")) {
                        event = line.substring(7);
                    } else if (line.startsWith("data: ") && "state".equals(event)) {
                        JSONObject st = new JSONObject(line.substring(6));
                        JSONArray pend = st.optJSONArray("pending");
                        JSONArray lsWait = st.optJSONArray("lsWaiting");
                        int nMirror = pend == null ? 0 : pend.length();
                        int nAgent = lsWait == null ? 0 : lsWait.length();
                        int n = nMirror + nAgent;
                        boolean busy = st.optBoolean("busy", false) || st.optBoolean("lsRunning", false);
                        if (!first) {
                            if (n > prevPending) {
                                StringBuilder labels = new StringBuilder();
                                for (int i = 0; i < nAgent; i++) {
                                    JSONObject it = lsWait.optJSONObject(i);
                                    if (it == null) continue;
                                    if (labels.length() > 0) labels.append(" / ");
                                    labels.append(it.optString("label"));
                                }
                                for (int i = 0; i < nMirror; i++) {
                                    JSONObject it = pend.optJSONObject(i);
                                    if (it == null) continue;
                                    if (labels.length() > 0) labels.append(" / ");
                                    labels.append(it.optString("label"));
                                }
                                alert("Antigravity needs your approval", labels.toString());
                            } else if (prevBusy && !busy && n == 0) {
                                alert("Antigravity", "The agent finished working.");
                            }
                        }
                        first = false;
                        prevPending = n;
                        prevBusy = busy;
                    } else if (line.isEmpty()) {
                        event = null;
                    }
                }
                r.close();
            } catch (Exception ignored) {
            }
            if (running) sleep(5000);
        }
    }
}
