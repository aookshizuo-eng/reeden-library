package xyz.aookshizuo.reedenlibrary;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.util.Locale;
/**
 * 在应用内用账号密码登录 123 云盘，再把会话 Token 交回主页面。
 *
 * <p>主 WebView 只允许停留在本站，所以网页登录必须另开一个受控 WebView。登录
 * 完成后 token 在 localStorage / sessionStorage / cookie 里，字段名会随 123 的
 * 前端版本变化，因此这里按 JWT 的形状去找，而不是写死某个 key。取回后由前端
 * 调用 Worker 的只读校验接口确认它真的能用。
 */
public final class Pan123LoginActivity extends Activity {
    private static final String START_URL = "https://www.123pan.com/";
    // 桌面 UA：手机 UA 会把这页引导到"下载 App"，账号密码入口反而藏起来。
    private static final String DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

    private static final String COLLECT_SCRIPT =
            "(function(){"
                    + "if (window.__rgCollectInstalled) return;"
                    + "window.__rgCollectInstalled = true;"
                    + "window.__rgJwt = function(value){"
                    + "  if (!value) return '';"
                    + "  var match = String(value).match(/eyJ[A-Za-z0-9_-]{6,}\\.[A-Za-z0-9_-]{6,}\\.[A-Za-z0-9_-]{6,}/);"
                    + "  return match ? match[0] : '';"
                    + "};"
                    + "window.__rgCollect = function(){"
                    + "  var found = []; var seen = {};"
                    + "  function add(source, value){"
                    + "    var token = window.__rgJwt(value);"
                    + "    if (!token || seen[token]) return;"
                    + "    seen[token] = 1; found.push({token: token, source: source});"
                    + "  }"
                    + "  try { for (var i = 0; i < localStorage.length; i++) { var key = localStorage.key(i); add('localStorage:' + key, localStorage.getItem(key)); } } catch (error) {}"
                    + "  try { for (var j = 0; j < sessionStorage.length; j++) { var key2 = sessionStorage.key(j); add('sessionStorage:' + key2, sessionStorage.getItem(key2)); } } catch (error) {}"
                    + "  try { add('cookie', document.cookie); } catch (error) {}"
                    + "  return found;"
                    + "};"
                    + "if (!window.__rgTimer) {"
                    + "  window.__rgTimer = setInterval(function(){"
                    + "    try {"
                    + "      var list = window.__rgCollect();"
                    + "      if (list.length && window.RedGardenPan123) {"
                    + "        clearInterval(window.__rgTimer); window.__rgTimer = null;"
                    + "        window.RedGardenPan123.deliver(JSON.stringify(list));"
                    + "      }"
                    + "    } catch (error) {}"
                    + "  }, 2500);"
                    + "}"
                    + "})();";

    private static final String SCAN_NOW_SCRIPT =
            "(function(){"
                    + "try {"
                    + "  if (typeof window.__rgCollect !== 'function') return;"
                    + "  var list = window.__rgCollect();"
                    + "  if (!window.RedGardenPan123) return;"
                    + "  if (list.length) window.RedGardenPan123.deliver(JSON.stringify(list));"
                    + "  else window.RedGardenPan123.status('empty');"
                    + "} catch (error) { window.RedGardenPan123 && window.RedGardenPan123.status('error'); }"
                    + "})();";

    private WebView webView;
    private TextView statusView;
    private ProgressBar progressBar;
    private boolean delivered;

    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(0xFFF2EEE5);
        setContentView(root);
        applyInsets(root);

        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(android.view.Gravity.CENTER_VERTICAL);
        header.setPadding(dp(16), dp(10), dp(8), dp(8));

        TextView title = new TextView(this);
        title.setText("登录 123 云盘");
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        title.setTextColor(0xFF1D1A15);
        title.setTypeface(title.getTypeface(), android.graphics.Typeface.BOLD);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        header.addView(title, titleParams);

        Button close = new Button(this);
        close.setText("关闭");
        close.setAllCaps(false);
        close.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        close.setTextColor(0xFF6A6355);
        close.setBackgroundColor(0x00000000);
        close.setPadding(dp(12), dp(6), dp(12), dp(6));
        close.setOnClickListener(v -> finish());
        header.addView(close);
        root.addView(header, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        progressBar.setProgress(0);
        LinearLayout.LayoutParams progressParams = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(2));
        root.addView(progressBar, progressParams);

        webView = new WebView(this);
        configure(webView);
        root.addView(webView, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        LinearLayout footer = new LinearLayout(this);
        footer.setOrientation(LinearLayout.VERTICAL);
        footer.setBackgroundColor(0xFFFFFDF8);
        footer.setPadding(dp(16), dp(10), dp(16), dp(12));

        statusView = new TextView(this);
        statusView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        statusView.setTextColor(0xFF6A6355);
        statusView.setText("在这里用账号或手机号 + 密码登录。登录成功会自动取回会话，也可以点下面的按钮手动取回。");
        footer.addView(statusView);

        Button scan = new Button(this);
        scan.setText("我已登录，取回会话 Token");
        scan.setAllCaps(false);
        scan.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        scan.setTextColor(0xFFFFFDF8);
        scan.setBackgroundColor(0xFF1D1A15);
        LinearLayout.LayoutParams scanParams = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(46));
        scanParams.topMargin = dp(8);
        scan.setOnClickListener(v -> scanNow());
        footer.addView(scan, scanParams);
        root.addView(footer, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        webView.addJavascriptInterface(new Pan123Bridge(), "RedGardenPan123");
        webView.loadUrl(START_URL);
    }

    private void applyInsets(View root) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
        }
        root.setOnApplyWindowInsetsListener((target, insets) -> {
            int top;
            int bottom;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                top = bars.top;
                bottom = bars.bottom;
            } else {
                top = insets.getSystemWindowInsetTop();
                bottom = insets.getSystemWindowInsetBottom();
            }
            target.setPadding(0, top, 0, bottom);
            return insets;
        });
        root.post(root::requestApplyInsets);
    }

    private void configure(WebView view) {
        view.setBackgroundColor(0xFFFFFDF8);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setUserAgentString(DESKTOP_UA);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setTextZoom(100);
        if (Build.VERSION.SDK_INT >= 33) settings.setAlgorithmicDarkeningAllowed(false);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) cookies.setAcceptThirdPartyCookies(view, true);

        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView v, int progress) {
                if (progressBar == null) return;
                progressBar.setProgress(progress);
                progressBar.setVisibility(progress >= 100 ? View.GONE : View.VISIBLE);
            }
        });
        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
                // 123 页面里的 "打开 App" 之类用的 intent:// 一律留在网页里。
                return !("http".equals(scheme) || "https".equals(scheme));
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                v.evaluateJavascript(COLLECT_SCRIPT, null);
            }
        });
    }

    private void scanNow() {
        if (webView == null) return;
        if (statusView != null) statusView.setText("正在页面里查找登录会话…");
        webView.evaluateJavascript(COLLECT_SCRIPT, null);
        webView.postDelayed(() -> {
            if (webView != null) webView.evaluateJavascript(SCAN_NOW_SCRIPT, null);
        }, 350);
    }

    private void finishWithTokens(String payload) {
        if (delivered) return;
        delivered = true;
        Intent result = new Intent();
        result.putExtra("tokens", payload);
        setResult(RESULT_OK, result);
        finish();
    }

    public final class Pan123Bridge {
        @JavascriptInterface
        public void deliver(String payload) {
            if (payload == null || payload.isEmpty()) return;
            runOnUiThread(() -> finishWithTokens(payload));
        }

        @JavascriptInterface
        public void status(String kind) {
            runOnUiThread(() -> {
                if ("empty".equals(kind)) {
                    if (statusView != null) statusView.setText("还没找到会话。请确认页面右上角已显示登录状态，再点一次「取回会话 Token」。");
                    Toast.makeText(Pan123LoginActivity.this, "未找到会话，请先完成登录", Toast.LENGTH_SHORT).show();
                } else {
                    if (statusView != null) statusView.setText("读取页面存储失败，请刷新登录页后重试。");
                }
            });
        }
    }
}
