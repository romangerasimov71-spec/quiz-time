package ru.german71.quiztime;

import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.FrameLayout;

import java.io.File;
import java.io.FileOutputStream;
import java.util.HashMap;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.core.content.FileProvider;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;

/**
 * The whole app: one WebView with the quiz web app from assets/www/ (the same files as in VK/OK).
 * The page is served from https://appassets.androidplatform.net/assets/www/ (not file://),
 * nothing outside that address is ever opened, the app has no permissions (not even INTERNET).
 * «Поделиться»: window.AppShare (ShareBridge below) opens the system share sheet (Intent.ACTION_SEND):
 * text, or a picture written to cache/share/ and given out through the FileProvider (no permission needed).
 */
public class MainActivity extends ComponentActivity {

    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/assets/www/index.html";
    /** The page looks for this mark in the user agent: no ads, no banner, no VK/OK links, free bonus. */
    private static final String UA_MARK = " QuizTimeAndroid/" + BuildConfig.VERSION_NAME;
    /** JS object of the page with back() and appPause(). */
    private static final String JS_APP = "QuizApp";
    private static final int BRAND = Color.parseColor("#BF360C");
    /** Largest picture to share (decoded bytes). The postcard / result card is well below 3 MB. */
    private static final int MAX_IMAGE_BYTES = 12 * 1024 * 1024;
    private static final int MAX_TEXT_CHARS = 30000;

    private WebView webView;
    private long lastShareAt = 0;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BRAND);   // behind the status bar and the navigation bar
        webView = new WebView(this);
        webView.setBackgroundColor(BRAND);
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        // the clock and the system buttons stay visible; the page sits between them (and above the keyboard)
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets i = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            v.setPadding(i.left, i.top, i.right, Math.max(i.bottom, ime.bottom));
            return WindowInsetsCompat.CONSUMED;
        });
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        bars.setAppearanceLightStatusBars(false);       // light icons on the dark brand color
        bars.setAppearanceLightNavigationBars(false);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                    // saved data (localStorage)
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setTextZoom(100);                              // the system font size must not break the layout (fonts are already large)
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setUserAgentString(s.getUserAgentString() + UA_MARK);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setHorizontalScrollBarEnabled(false);
        webView.addJavascriptInterface(new ShareBridge(), "AppShare");

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();
        webView.setWebViewClient(new WebViewClientCompat() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (HOST.equals(url.getHost())) return loader.shouldInterceptRequest(url);
                // anything outside the app: empty answer, no network
                return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<>(), null);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // never leave the app: links to other addresses are not opened
                return !HOST.equals(request.getUrl().getHost());
            }
        });

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                // the page closes its open window / goes one screen up and answers true; false = main screen -> exit
                webView.evaluateJavascript(
                        "(function(){try{return !!(window." + JS_APP + "&&" + JS_APP + ".back&&" + JS_APP + ".back());}catch(e){return false;}})()",
                        value -> {
                            if (!"true".equals(value)) finish();
                        });
            }
        });

        webView.loadUrl(START_URL);
    }

    /** window.AppShare in the page: the system share sheet. Methods run on a WebView thread. */
    private final class ShareBridge {
        @JavascriptInterface
        public boolean shareText(String title, String text) {
            if (text == null || text.trim().isEmpty() || tooSoon()) return false;
            final Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("text/plain");
            send.putExtra(Intent.EXTRA_TEXT, cap(text));
            if (title != null && !title.isEmpty()) send.putExtra(Intent.EXTRA_SUBJECT, title);
            runOnUiThread(() -> openChooser(send));
            return true;
        }

        @JavascriptInterface
        public boolean shareImage(String dataUrl, String fileName, String text, String title) {
            if (dataUrl == null || tooSoon()) return false;
            String mime;
            String ext;
            if (dataUrl.startsWith("data:image/png;base64,")) { mime = "image/png"; ext = ".png"; }
            else if (dataUrl.startsWith("data:image/jpeg;base64,")) { mime = "image/jpeg"; ext = ".jpg"; }
            else return false;
            try {
                byte[] bytes = Base64.decode(dataUrl.substring(dataUrl.indexOf(',') + 1), Base64.DEFAULT);
                if (bytes.length == 0 || bytes.length > MAX_IMAGE_BYTES) return false;
                File dir = new File(getCacheDir(), "share");
                if (!dir.isDirectory() && !dir.mkdirs()) return false;
                File[] old = dir.listFiles();
                if (old != null) for (File f : old) //noinspection ResultOfMethodCallIgnored
                    f.delete();
                String base = fileName == null ? "" : fileName.replaceAll("\\.[A-Za-z0-9]+$", "").replaceAll("[^A-Za-z0-9_-]", "");
                if (base.isEmpty()) base = "image";
                File file = new File(dir, base + ext);
                try (FileOutputStream out = new FileOutputStream(file)) { out.write(bytes); }
                Uri uri = FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".share", file);
                final Intent send = new Intent(Intent.ACTION_SEND);
                send.setType(mime);
                send.putExtra(Intent.EXTRA_STREAM, uri);
                if (text != null && !text.trim().isEmpty()) send.putExtra(Intent.EXTRA_TEXT, cap(text));
                if (title != null && !title.isEmpty()) send.putExtra(Intent.EXTRA_SUBJECT, title);
                send.setClipData(ClipData.newRawUri("", uri));
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                runOnUiThread(() -> openChooser(send));
                return true;
            } catch (Exception e) {
                return false;
            }
        }
    }

    private synchronized boolean tooSoon() {
        long now = SystemClock.elapsedRealtime();
        if (now - lastShareAt < 800) return true;      // double tap: one share sheet
        lastShareAt = now;
        return false;
    }

    private static String cap(String text) {
        return text.length() > MAX_TEXT_CHARS ? text.substring(0, MAX_TEXT_CHARS) : text;
    }

    private void openChooser(Intent send) {
        if (isFinishing()) return;
        Intent chooser = Intent.createChooser(send, getString(R.string.share_title));
        chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            startActivity(chooser);
        } catch (ActivityNotFoundException e) {
            // no app to share with: nothing happens
        }
    }

    private void setAppPaused(boolean paused) {
        if (webView == null) return;
        webView.evaluateJavascript(
                "(function(){try{if(window." + JS_APP + "&&" + JS_APP + ".appPause)" + JS_APP + ".appPause(" + paused + ");}catch(e){}})()", null);
    }

    @Override
    protected void onPause() {
        // save / silence first, then stop the WebView
        setAppPaused(true);
        if (webView != null) {
            webView.onPause();
            webView.pauseTimers();
        }
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.resumeTimers();
            webView.onResume();
        }
        setAppPaused(false);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.stopLoading();
            ViewGroup parent = (ViewGroup) webView.getParent();
            if (parent != null) parent.removeView(webView);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
