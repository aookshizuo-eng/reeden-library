package xyz.aookshizuo.reedenlibrary;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.Intent;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.IOException;
import java.io.InputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

public final class MainActivity extends Activity {
    private static final int FILE_CHOOSER_REQUEST = 1001;
    private static final String HOME_URL = "https://aookshizuo-eng.github.io/reeden-library/";
    private static final String SITE_HOST = "aookshizuo-eng.github.io";
    private static final String SITE_PREFIX = "/reeden-library";

    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        webView = new WebView(this);
        setContentView(webView);
        configureSafeInsets(webView);
        configureWebView(webView);
        webView.loadUrl(HOME_URL);
    }

    private void configureSafeInsets(View view) {
        // Android 15 draws edge-to-edge for targetSdk 35. Keep the web app's
        // top bar, menus, and download controls clear of system bars/notches.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
        }
        view.setOnApplyWindowInsetsListener((target, insets) -> {
            int left;
            int top;
            int right;
            int bottom;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                left = bars.left;
                top = bars.top;
                right = bars.right;
                bottom = bars.bottom;
            } else {
                left = insets.getSystemWindowInsetLeft();
                top = insets.getSystemWindowInsetTop();
                right = insets.getSystemWindowInsetRight();
                bottom = insets.getSystemWindowInsetBottom();
            }
            target.setPadding(left, top, right, bottom);
            return insets;
        });
        view.post(view::requestApplyInsets);
    }

    private void configureWebView(WebView view) {
        WebView.setWebContentsDebuggingEnabled(false);
        view.getSettings().setJavaScriptEnabled(true);
        view.getSettings().setDomStorageEnabled(true);
        view.getSettings().setDatabaseEnabled(true);
        view.getSettings().setAllowFileAccess(false);
        view.getSettings().setAllowContentAccess(false);
        view.getSettings().setBuiltInZoomControls(false);
        view.getSettings().setDisplayZoomControls(false);
        view.getSettings().setMediaPlaybackRequiresUserGesture(true);
        CookieManager.getInstance().setAcceptCookie(true);

        view.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                return openBundledSiteAsset(request.getUrl(), request.getMethod());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (isSiteUrl(uri)) return false;
                // Object links are handled by DownloadManager below. Do not
                // let arbitrary pages replace the app's controlled origin.
                Toast.makeText(MainActivity.this, "已阻止离开 Red Garden", Toast.LENGTH_SHORT).show();
                return true;
            }
        });
        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    Intent intent = params.createIntent();
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    }
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                } catch (Exception error) {
                    fileCallback = null;
                    callback.onReceiveValue(null);
                    Toast.makeText(MainActivity.this, "无法打开文件选择器", Toast.LENGTH_SHORT).show();
                }
                return true;
            }
        });
        view.setDownloadListener((DownloadListener) (url, userAgent, contentDisposition, mimeType, contentLength) -> {
            enqueueDownload(url, userAgent, contentDisposition, mimeType);
        });
    }

    private boolean isSiteUrl(Uri uri) {
        if (uri == null || !"https".equalsIgnoreCase(uri.getScheme())) return false;
        if (!SITE_HOST.equalsIgnoreCase(uri.getHost())) return false;
        String path = uri.getPath() == null ? "/" : uri.getPath();
        return path.equals(SITE_PREFIX) || path.startsWith(SITE_PREFIX + "/");
    }

    private WebResourceResponse openBundledSiteAsset(Uri uri, String method) {
        if (uri == null || method == null || !"GET".equalsIgnoreCase(method) || !isSiteUrl(uri)) return null;
        String path = uri.getPath() == null ? "/" : uri.getPath();
        String relative = path.substring(SITE_PREFIX.length());
        if (relative.isEmpty() || "/".equals(relative)) relative = "/index.html";
        try {
            relative = URLDecoder.decode(relative, StandardCharsets.UTF_8.name());
        } catch (Exception ignored) {
            return null;
        }
        if (relative.startsWith("/")) relative = relative.substring(1);
        if (relative.isEmpty() || relative.contains("..") || relative.contains("\\")) return null;
        // The Gradle source set points directly at ../../site, so its files
        // are stored at the root of the APK assets directory.
        String assetName = relative;
        try {
            InputStream stream = getAssets().open(assetName);
            String mime = mimeFor(relative);
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-cache");
            headers.put("Access-Control-Allow-Origin", "https://" + SITE_HOST);
            return new WebResourceResponse(mime, mime.startsWith("text/") || "application/javascript".equals(mime) ? "UTF-8" : null, 200, "OK", headers, stream);
        } catch (IOException ignored) {
            // Missing optional assets may still be fetched from Pages.
            return null;
        }
    }

    private static String mimeFor(String path) {
        String ext = "";
        int dot = path.lastIndexOf('.');
        if (dot >= 0 && dot + 1 < path.length()) ext = path.substring(dot + 1).toLowerCase(Locale.ROOT);
        if ("js".equals(ext) || "mjs".equals(ext)) return "application/javascript";
        if ("css".equals(ext)) return "text/css";
        if ("html".equals(ext)) return "text/html";
        if ("json".equals(ext)) return "application/json";
        if ("svg".equals(ext)) return "image/svg+xml";
        if ("jpg".equals(ext) || "jpeg".equals(ext)) return "image/jpeg";
        if ("png".equals(ext)) return "image/png";
        if ("gif".equals(ext)) return "image/gif";
        String guessed = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return guessed == null ? "application/octet-stream" : guessed;
    }

    private void enqueueDownload(String url, String userAgent, String contentDisposition, String mimeType) {
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) {
            Toast.makeText(this, "此下载链接无法交给系统下载器", Toast.LENGTH_SHORT).show();
            return;
        }
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            if (mimeType != null && !mimeType.isEmpty()) request.setMimeType(mimeType);
            if (userAgent != null && !userAgent.isEmpty()) request.addRequestHeader("User-Agent", userAgent);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            String filename = android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename);
            DownloadManager manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            if (manager == null) throw new IllegalStateException("DownloadManager unavailable");
            manager.enqueue(request);
            Toast.makeText(this, "已加入下载队列", Toast.LENGTH_SHORT).show();
        } catch (Exception error) {
            Toast.makeText(this, "下载失败，请稍后重试", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST || fileCallback == null) return;
        Uri[] results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
        fileCallback.onReceiveValue(results);
        fileCallback = null;
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
        }
        super.onDestroy();
    }
}
