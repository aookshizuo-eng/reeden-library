package xyz.aookshizuo.reedenlibrary;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;

public final class MainActivity extends Activity {
    private static final int FILE_CHOOSER_REQUEST = 1001;
    private static final String HOME_URL = "https://aookshizuo-eng.github.io/reeden-library/";
    private static final String SITE_HOST = "aookshizuo-eng.github.io";
    private static final String SITE_PREFIX = "/reeden-library";

    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    // Documents the user opened through this app's own chooser. The web layer may
    // only ask to delete these, matched by display name and size, so a stray call
    // can never reach a file the user never picked here.
    private final List<Uri> pickedUris = new ArrayList<>();
    private volatile String currentPageUrl = HOME_URL;

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
        view.setBackgroundColor(0xFFF7F9FA);
        view.getSettings().setJavaScriptEnabled(true);
        view.getSettings().setDomStorageEnabled(true);
        view.getSettings().setDatabaseEnabled(true);
        view.getSettings().setAllowFileAccess(false);
        view.getSettings().setAllowContentAccess(false);
        view.getSettings().setBuiltInZoomControls(false);
        view.getSettings().setDisplayZoomControls(false);
        view.getSettings().setMediaPlaybackRequiresUserGesture(true);
        // The layout is already responsive; letting the system font scale blow it
        // up (or force-dark the light theme) is what made the phone view look
        // broken, so pin both to the web app's own settings.
        view.getSettings().setTextZoom(100);
        if (Build.VERSION.SDK_INT >= 33) view.getSettings().setAlgorithmicDarkeningAllowed(false);
        CookieManager.getInstance().setAcceptCookie(true);
        view.addJavascriptInterface(new LocalFileBridge(), "RedGardenNative");

        view.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView v, String url, Bitmap favicon) {
                currentPageUrl = url == null ? "" : url;
            }

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
                    // OPEN_DOCUMENT (not GET_CONTENT) is what lets the provider
                    // hand back a deletable document: we ask for write access up
                    // front, so "delete the local copy after upload" can actually
                    // be honoured instead of failing at the end of a long upload.
                    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                            | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                    // accept may be a list of extensions (.red, .ttf) that the
                    // document UI cannot filter on; only real MIME types help.
                    String[] accept = params.getAcceptTypes();
                    if (accept != null && accept.length > 0 && accept[0] != null && accept[0].contains("/")) {
                        intent.putExtra(Intent.EXTRA_MIME_TYPES, accept);
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
        synchronized (pickedUris) {
            pickedUris.clear();
            if (results != null) {
                for (Uri uri : results) if (uri != null) pickedUris.add(uri);
            }
        }
        fileCallback.onReceiveValue(results);
        fileCallback = null;
    }

    private boolean isTrustedPage() {
        try {
            return isSiteUrl(Uri.parse(currentPageUrl == null ? "" : currentPageUrl));
        } catch (Exception ignored) {
            return false;
        }
    }

    private static final class DocumentInfo {
        final String name;
        final long size;

        DocumentInfo(String name, long size) {
            this.name = name;
            this.size = size;
        }
    }

    private DocumentInfo describe(Uri uri) {
        try (Cursor cursor = getContentResolver().query(uri,
                new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                if (cursor.isNull(0)) return null;
                String name = cursor.getString(0);
                long size = cursor.isNull(1) ? -1L : cursor.getLong(1);
                return name == null ? null : new DocumentInfo(name, size);
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    // Removing the bookmark after a successful match keeps a second call from
    // deleting a different file that happens to share the same name.
    private Uri takePickedUri(String name, long size) {
        synchronized (pickedUris) {
            for (Iterator<Uri> iterator = pickedUris.iterator(); iterator.hasNext(); ) {
                Uri uri = iterator.next();
                DocumentInfo info = describe(uri);
                if (info == null) {
                    iterator.remove();
                    continue;
                }
                if (!name.equals(info.name)) continue;
                if (size >= 0 && info.size >= 0 && size != info.size) continue;
                iterator.remove();
                return uri;
            }
            return null;
        }
    }

    private String deleteDocument(Uri uri) {
        try {
            if (DocumentsContract.deleteDocument(getContentResolver(), uri)) return null;
        } catch (Exception ignored) {
        }
        try {
            if (getContentResolver().delete(uri, null, null) > 0) return null;
        } catch (Exception ignored) {
        }
        return "系统或来源应用不允许删除该文件";
    }

    private static JSONObject failure(String name, String reason) {
        JSONObject object = new JSONObject();
        try {
            object.put("name", name == null ? "" : name);
            object.put("reason", reason);
        } catch (Exception ignored) {
        }
        return object;
    }

    public final class LocalFileBridge {
        @JavascriptInterface
        public String capability() {
            return isTrustedPage() ? "{\"canDelete\":true}" : "{\"canDelete\":false}";
        }

        @JavascriptInterface
        public String deleteFiles(String payload) {
            if (!isTrustedPage()) {
                return "{\"deleted\":0,\"failed\":[],\"unsupported\":true,\"message\":\"当前页面不在受信任站点，未执行删除\"}";
            }
            int deleted = 0;
            JSONArray failed = new JSONArray();
            try {
                JSONArray requested = new JSONArray(payload == null || payload.isEmpty() ? "[]" : payload);
                for (int index = 0; index < requested.length(); index++) {
                    JSONObject item = requested.optJSONObject(index);
                    if (item == null) continue;
                    String name = item.optString("name", "");
                    long size = item.optLong("size", -1L);
                    Uri match = takePickedUri(name, size);
                    if (match == null) {
                        failed.put(failure(name, "这次选择里没有这个文件，请手动删除"));
                        continue;
                    }
                    String error = deleteDocument(match);
                    if (error == null) deleted++;
                    else failed.put(failure(name, error));
                }
            } catch (Exception error) {
                failed.put(failure("", "删除请求解析失败：" + error.getMessage()));
            }
            JSONObject result = new JSONObject();
            try {
                result.put("deleted", deleted);
                result.put("failed", failed);
            } catch (Exception ignored) {
            }
            return result.toString();
        }
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
