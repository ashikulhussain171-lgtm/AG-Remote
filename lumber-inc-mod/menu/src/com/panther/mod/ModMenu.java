package com.panther.mod;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.CompoundButton;
import android.widget.LinearLayout;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

/** Small floating on/off menu. Called once from UnityPlayerActivity.onCreate. */
public final class ModMenu {
    private static final String TAG = "PantherMods";
    private static final String PREFS = "panther_mods";
    private static final MemPatcher MEM = new MemPatcher();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static boolean started;

    private static final Object[][] ITEMS = {
        { Patches.Group.CURRENCY,   "Unlimited Currency" },
        { Patches.Group.FREE_SPEND, "Free Upgrades / Level Up" },
        { Patches.Group.NO_ADS,     "No Ads" },
    };

    private ModMenu() { }

    public static void start(final Activity activity) {
        try {
            if (started) return;
            started = true;
            final SharedPreferences prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            attachWhenReady(activity, prefs, 0);
            toast(activity, "Panther Mods loaded");
            Thread t = new Thread(new Runnable() {
                @Override public void run() { waitForGameAndApply(activity, prefs); }
            }, "PantherModsInit");
            t.setDaemon(true);
            t.start();
        } catch (Throwable e) {
            Log.e(TAG, "start failed", e);
        }
    }

    /** libil2cpp.so is mapped some time after onCreate; apply the saved switches once it is. */
    private static void waitForGameAndApply(Activity activity, SharedPreferences prefs) {
        try {
            for (int i = 0; i < 240 && !MEM.resolve(); i++) Thread.sleep(500);
            if (!MEM.isResolved()) { toast(activity, "Panther Mods: game code not found"); return; }
            for (Object[] it : ITEMS) {
                Patches.Group g = (Patches.Group) it[0];
                if (prefs.getBoolean(g.name(), false)) {
                    String err = MEM.setGroup(g, true);
                    if (err != null) toast(activity, it[1] + ": " + err);
                }
            }
        } catch (Throwable e) {
            Log.e(TAG, "apply failed", e);
            toast(activity, "Panther Mods: " + e);
        }
    }

    private static void apply(final Activity activity, final SharedPreferences prefs, final Patches.Group g,
                              final String label, final boolean on, final CompoundButton sw) {
        new Thread(new Runnable() {
            @Override public void run() {
                String err;
                try {
                    if (!MEM.isResolved()) MEM.resolve();
                    err = MEM.setGroup(g, on);
                } catch (Throwable e) {
                    err = e.toString();
                }
                if (err == null) {
                    prefs.edit().putBoolean(g.name(), on).apply();
                } else {
                    final String msg = label + ": " + err;
                    MAIN.post(new Runnable() {
                        @Override public void run() {
                            sw.setOnCheckedChangeListener(null);
                            sw.setChecked(!on);
                            sw.setOnCheckedChangeListener(listener(activity, prefs, g, label));
                            Toast.makeText(activity, msg, Toast.LENGTH_LONG).show();
                        }
                    });
                }
            }
        }, "PantherModsToggle").start();
    }

    private static CompoundButton.OnCheckedChangeListener listener(final Activity a, final SharedPreferences prefs,
                                                                   final Patches.Group g, final String label) {
        return new CompoundButton.OnCheckedChangeListener() {
            @Override public void onCheckedChanged(CompoundButton b, boolean on) { apply(a, prefs, g, label, on, b); }
        };
    }

    /** The panel is its own sub-window above the game's SurfaceView; it needs the activity's window token. */
    private static void attachWhenReady(final Activity a, final SharedPreferences prefs, final int tries) {
        MAIN.postDelayed(new Runnable() {
            @Override public void run() {
                if (a.isFinishing()) return;
                View decor = a.getWindow().getDecorView();
                if (decor.getWindowToken() == null) {
                    if (tries < 60) attachWhenReady(a, prefs, tries + 1);
                    else Log.e(TAG, "no window token, menu not shown");
                    return;
                }
                attach(a, prefs, decor);
            }
        }, tries == 0 ? 300 : 500);
    }

    private static void attach(final Activity a, final SharedPreferences prefs, View decor) {
        try {
            final WindowManager wm = a.getWindowManager();

            final TextView bubble = new TextView(a);
            bubble.setText("P");
            bubble.setTextColor(Color.WHITE);
            bubble.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
            bubble.setGravity(Gravity.CENTER);
            bubble.setBackground(round(0xCC1E88E5, dp(a, 18)));
            int bs = dp(a, 36);

            final LinearLayout panel = new LinearLayout(a);
            panel.setOrientation(LinearLayout.VERTICAL);
            panel.setPadding(dp(a, 10), dp(a, 8), dp(a, 10), dp(a, 8));
            panel.setBackground(round(0xE6202124, dp(a, 10)));
            panel.setVisibility(View.GONE);

            TextView title = new TextView(a);
            title.setText("Panther Mods");
            title.setTextColor(0xFF64B5F6);
            title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            panel.addView(title);

            for (Object[] it : ITEMS) {
                Patches.Group g = (Patches.Group) it[0];
                String label = (String) it[1];
                Switch sw = new Switch(a);
                sw.setText(label);
                sw.setTextColor(Color.WHITE);
                sw.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
                sw.setChecked(prefs.getBoolean(g.name(), false));
                sw.setOnCheckedChangeListener(listener(a, prefs, g, label));
                panel.addView(sw, new LinearLayout.LayoutParams(dp(a, 200), ViewGroup.LayoutParams.WRAP_CONTENT));
            }

            final LinearLayout column = new LinearLayout(a);
            column.setOrientation(LinearLayout.VERTICAL);
            column.addView(bubble, new LinearLayout.LayoutParams(bs, bs));
            LinearLayout.LayoutParams plp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            plp.topMargin = dp(a, 4);
            column.addView(panel, plp);

            final WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
                    WindowManager.LayoutParams.TYPE_APPLICATION_PANEL,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                            | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                            | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                    PixelFormat.TRANSLUCENT);
            lp.gravity = Gravity.TOP | Gravity.START;
            lp.token = decor.getWindowToken();
            lp.x = dp(a, 4);
            lp.y = dp(a, 160);

            bubble.setOnTouchListener(new View.OnTouchListener() {
                int ox, oy; float sx, sy;
                @Override public boolean onTouch(View v, MotionEvent e) {
                    switch (e.getActionMasked()) {
                        case MotionEvent.ACTION_DOWN:
                            ox = lp.x; oy = lp.y; sx = e.getRawX(); sy = e.getRawY();
                            return true;
                        case MotionEvent.ACTION_MOVE:
                            lp.x = Math.max(0, ox + (int) (e.getRawX() - sx));
                            lp.y = Math.max(0, oy + (int) (e.getRawY() - sy));
                            wm.updateViewLayout(column, lp);
                            return true;
                        case MotionEvent.ACTION_UP:
                            if (Math.abs(e.getRawX() - sx) < 10 && Math.abs(e.getRawY() - sy) < 10)
                                panel.setVisibility(panel.getVisibility() == View.VISIBLE ? View.GONE : View.VISIBLE);
                            return true;
                    }
                    return false;
                }
            });

            wm.addView(column, lp);
        } catch (Throwable e) {
            Log.e(TAG, "menu attach failed", e);
            toast(a, "Panther Mods menu error: " + e);
        }
    }

    private static GradientDrawable round(int color, int radius) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(radius);
        return d;
    }

    private static int dp(Context c, int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, c.getResources().getDisplayMetrics());
    }

    private static void toast(final Activity a, final String msg) {
        MAIN.post(new Runnable() { @Override public void run() { Toast.makeText(a, msg, Toast.LENGTH_LONG).show(); } });
    }
}
