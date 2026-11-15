package xyz.aookshizuo.reedenlibrary;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ClipData;
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

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public final class MainActivity extends Activity {
    private static final int FILE_CHOOSER_REQUEST = 1001;
    private static final int PAN123_LOGIN_REQUEST = 1002;
    private static final String HOME_URL = "https://aookshizuo-eng.github.io/reeden-library/";
    private static final String SITE_HOST = "aookshizuo-eng.github.io";
    private static final String SITE_PREFIX = "/reeden-library";

    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    // 这次选择器是否支持多选（<input multiple>）。多选结果的 content URI 交给
    // WebView 并不可靠，所以只要是多选型输入框，一律改走原生复制通道。
    private boolean fileChooserMulti = false;
    // Documents the user opened through this app's own chooser. The web layer may
    // only ask to delete these, matched by display name and size, so a stray call
    // can never reach a file the user never picked here. 按「名字@大小」累积：
    // 以前每次选择都清空，批量导入后再统一删除时只剩最后一批能对上，表现就是
    // 弹窗里列了 N 个文件却只删掉一个。
    private final Map<String, Uri> pickedDocuments = new java.util.LinkedHashMap<>();
    private volatile String currentPageUrl = HOME_URL;
    // 从别的应用分享进来的文件：先复制到 cache，再让网页用同源 URL 读走。
    // 用 URL 而不是 base64 桥，是因为主题动辄 20 MB，base64 字符串会直接
    // 把 WebView 撑着，而 shouldInterceptRequest 是流式的。
    private static final String SHARED_PREFIX = SITE_PREFIX + "/__shared__/";
    private final Map<String, File> sharedFiles = new ConcurrentHashMap<>();
    private final org.json.JSONArray sharedMeta = new org.json.JSONArray();
    private int sharedSequence = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        webView = new WebView(this);
        setContentView(webView);
        configureSafeInsets(webView);
        configureWebView(webView);
        handleShareIntent(getIntent());
        webView.loadUrl(HOME_URL);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleShareIntent(intent);
    }

    /** 接收 ACTION_SEND / ACTION_SEND_MULTIPLE，把文件复制进 cache 并通知网页。 */
    private void handleShareIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        boolean single = Intent.ACTION_SEND.equals(action);
        boolean multiple = Intent.ACTION_SEND_MULTIPLE.equals(action);
        if (!single && !multiple) return;
        final List<Uri> uris = new ArrayList<>();
        try {
            if (single) {
                Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (uri != null) uris.add(uri);
            } else {
                ArrayList<Uri> extra = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (extra != null) uris.addAll(extra);
            }
        } catch (Exception ignored) {
        }
        // 同一个 Intent 可能被重复投递（旋转屏幕、回到前台），取过的就不再处理。
        intent.removeExtra(Intent.EXTRA_STREAM);
        if (uris.isEmpty()) return;
        new Thread(() -> {
            for (Uri uri : uris) importSharedUri(uri);
            runOnUiThread(this::publishSharedFiles);
        }, "red-garden-share").start();
    }

    private boolean importSharedUri(Uri uri) {
        DocumentInfo info = describe(uri);
        String name = info != null && info.name != null ? info.name : "分享文件";
        String extension = "";
        int dot = name.lastIndexOf('.');
        if (dot >= 0 && dot + 1 < name.length()) extension = name.substring(dot + 1).toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]", "");
        // nanoTime 在同一批循环里可能取到同一个值，加序号避免多选时互相覆盖。
        String id;
        synchronized (this) {
            sharedSequence++;
            id = Long.toHexString(System.nanoTime()) + "-" + sharedSequence + (extension.isEmpty() ? "" : "." + extension);
        }
        File dir = new File(getCacheDir(), "shared");
        if (!dir.isDirectory() && !dir.mkdirs()) return false;
        File target = new File(dir, id);
        long total = 0;
        try (InputStream input = getContentResolver().openInputStream(uri);
             OutputStream output = new FileOutputStream(target)) {
            if (input == null) throw new IOException("无法读取分享的文件");
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) > 0) {
                output.write(buffer, 0, read);
                total += read;
            }
        } catch (Exception error) {
            target.delete();
            return false;
        }
        sharedFiles.put(id, target);
        try {
            org.json.JSONObject meta = new org.json.JSONObject();
            meta.put("id", id);
            meta.put("name", name);
            meta.put("size", total);
            synchronized (sharedMeta) {
                sharedMeta.put(meta);
            }
        } catch (Exception ignored) {
        }
        return true;
    }

    private String sharedMetaJson() {
        synchronized (sharedMeta) {
            return sharedMeta.toString();
        }
    }

    private void publishSharedFiles() {
        if (webView == null || sharedFiles.isEmpty()) return;
        String script = "window.onRedGardenSharedFiles && window.onRedGardenSharedFiles("
                + org.json.JSONObject.quote(sharedMetaJson()) + ");";
        deliverSharedFiles(script, 0);
    }

    /**
     * 页面可能还没执行到 app.js（冷启动后马上分享、或刚选完文件时仍在加载），
     * 这时注入会静默丢掉。先确认回调存在，最多重试 6 次，仍失败就留给页面
     * 启动时的 pullSharedFiles 兜底（sharedMeta 不会丢）。
     */
    private void deliverSharedFiles(String script, int attempt) {
        if (webView == null) return;
        webView.evaluateJavascript("typeof window.onRedGardenSharedFiles === 'function'", value -> {
            if ("true".equals(value)) {
                webView.evaluateJavascript(script, null);
                return;
            }
            if (attempt >= 6) return;
            webView.postDelayed(() -> deliverSharedFiles(script, attempt + 1), 700);
        });
    }

    private WebResourceResponse openSharedFile(Uri uri, String method) {
        if (uri == null || method == null || !"GET".equalsIgnoreCase(method) || !isSiteUrl(uri)) return null;
        String path = uri.getPath() == null ? "" : uri.getPath();
        if (!path.startsWith(SHARED_PREFIX)) return null;
        String id = path.substring(SHARED_PREFIX.length());
        File file = sharedFiles.get(id);
        if (file == null || !file.isFile()) return null;
        try {
            InputStream stream = new FileInputStream(file);
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-store");
            return new WebResourceResponse("application/octet-stream", null, 200, "OK", headers, stream);
        } catch (IOException error) {
            return null;
        }
    }

    private void releaseSharedFiles(String idsJson) {
        List<String> ids = new ArrayList<>();
        try {
            org.json.JSONArray array = new org.json.JSONArray(idsJson == null || idsJson.isEmpty() ? "[]" : idsJson);
            for (int index = 0; index < array.length(); index++) ids.add(array.getString(index));
        } catch (Exception ignored) {
        }
        for (String id : ids) {
            File file = sharedFiles.remove(id);
            if (file != null) file.delete();
        }
        synchronized (sharedMeta) {
            for (int index = sharedMeta.length() - 1; index >= 0; index--) {
                org.json.JSONObject item = sharedMeta.optJSONObject(index);
                if (item == null || !ids.contains(item.optString("id"))) continue;
                sharedMeta.remove(index);
            }
        }
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
        view.setBackgroundColor(0xFFFFFDF8);
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
                WebResourceResponse shared = openSharedFile(request.getUrl(), request.getMethod());
                if (shared != null) return shared;
                return openBundledSiteAsset(request.getUrl(), request.getMethod());
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                publishSharedFiles();
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (isSiteUrl(uri)) return false;
                // The API lives on another origin. Let attachment responses
                // through so WebView's DownloadListener can hand them to
                // DownloadManager; previews stay on the site and everything
                // else is still blocked from replacing the app's page.
                if (isDownloadUrl(uri)) return false;
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
                    fileChooserMulti = params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE;
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

    /** Read-only sync endpoints that are allowed to leave the app origin only
     * as downloads. The Worker validates ids/keys, and `download=1` objects
     * carry Content-Disposition, so WebView fires DownloadListener instead of
     * navigating away. Inline previews (no download flag) still get blocked. */
    private boolean isDownloadUrl(Uri uri) {
        if (uri == null || !"https".equalsIgnoreCase(uri.getScheme())) return false;
        String path = uri.getPath() == null ? "" : uri.getPath();
        if (path.equals("/api/download")) return true;
        if (!path.startsWith("/api/objects/")) return false;
        return "1".equals(uri.getQueryParameter("download"));
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
        if (url != null && url.startsWith("blob:")) {
            Toast.makeText(this, "浏览器临时文件无法直接保存，请勾选「打包成 ZIP」重试", Toast.LENGTH_LONG).show();
            return;
        }
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) {
            Toast.makeText(this, "此下载链接无法交给系统下载器", Toast.LENGTH_SHORT).show();
            return;
        }
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            if (mimeType != null && !mimeType.isEmpty()) request.setMimeType(mimeType);
            if (userAgent != null && !userAgent.isEmpty()) request.addRequestHeader("User-Agent", userAgent);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            // Android's URLUtil only reads the ASCII half of Content-Disposition,
            // so a Chinese theme name would land on disk as underscores. The web
            // layer sends the readable name in `name=` for exactly that reason.
            String filename = "";
            try {
                String hinted = Uri.parse(url).getQueryParameter("name");
                if (hinted != null) filename = hinted.trim();
            } catch (Exception ignored) { }
            if (filename.isEmpty()) filename = android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType);
            filename = filename.replaceAll("[\\\\/:*?\"<>|\\r\\n]", "_").trim();
            if (filename.isEmpty()) filename = "redgarden-download";
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
        if (requestCode == PAN123_LOGIN_REQUEST) {
            if (resultCode != RESULT_OK || data == null) return;
            String tokens = data.getStringExtra("tokens");
            if (tokens == null || tokens.isEmpty() || webView == null) return;
            // 用 JSONObject.quote 生成合法的 JS 字符串字面量，避免 token 里的
            // 引号或反斜杠把注入的脚本弄坏。
            String script = "window.onRedGardenPan123Login && window.onRedGardenPan123Login(" + JSONObject.quote(tokens) + ");";
            webView.evaluateJavascript(script, null);
            return;
        }
        if (requestCode != FILE_CHOOSER_REQUEST || fileCallback == null) return;
        Uri[] results = collectResultUris(resultCode, data);
        boolean multiMode = fileChooserMulti;
        fileChooserMulti = false;
        if (results == null || results.length == 0) {
            fileCallback.onReceiveValue(null);
            fileCallback = null;
            return;
        }
        // 记下这次选择的文档，后面「上传后删除本地副本」要用它按名字+大小匹配。
        rememberPickedDocuments(results);
        if (results.length > 1 || multiMode) {
            // 多选时不再把 content URI 数组交回 WebView。国产 ROM 的文档提供器
            // 经常只让 WebView 拿到第一个 URI（其余静默丢掉），有时干脆一个都不
            // 认，表现就是"单选能导入、多选没反应"。这里关闭选择结果，把文件复制
            // 进 cache，复用已经验证过的分享通道（/__shared__/<id> 同源流式读取）
            // 交给页面按后缀分流，路径与「分享到 APK」完全一致。
            fileCallback.onReceiveValue(null);
            fileCallback = null;
            final Uri[] batch = results;
            Toast.makeText(this, batch.length > 1 ? "正在读取 " + batch.length + " 个文件…" : "正在读取文件…", Toast.LENGTH_SHORT).show();
            new Thread(() -> {
                int copied = 0;
                for (Uri uri : batch) if (importSharedUri(uri)) copied++;
                final int ok = copied;
                runOnUiThread(() -> {
                    if (ok == 0) {
                        Toast.makeText(this, "读取所选文件失败，请重新选择", Toast.LENGTH_LONG).show();
                        return;
                    }
                    publishSharedFiles();
                });
            }, "red-garden-pick").start();
            return;
        }
        fileCallback.onReceiveValue(results);
        fileCallback = null;
    }

    /**
     * 自己解析选择结果，而不是用 FileChooserParams.parseResult：那个实现只读
     * clipData 或 data 其中之一，部分提供器两者都给，或把多选塞进 clipData 而
     * data 为空，逐个来源都收一遍再按 URI 去重更稳。
     */
    private Uri[] collectResultUris(int resultCode, Intent data) {
        if (resultCode != RESULT_OK || data == null) return null;
        List<Uri> uris = new ArrayList<>();
        ClipData clip = data.getClipData();
        if (clip != null) {
            for (int index = 0; index < clip.getItemCount(); index++) {
                Uri uri = clip.getItemAt(index).getUri();
                if (uri != null && !uris.contains(uri)) uris.add(uri);
            }
        }
        Uri single = data.getData();
        if (single != null && !uris.contains(single)) uris.add(single);
        if (uris.isEmpty()) return null;
        return uris.toArray(new Uri[0]);
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
    private static String documentKey(String name, long size) {
        return (name == null ? "" : name) + "@" + size;
    }

    private void rememberPickedDocuments(Uri[] results) {
        if (results == null) return;
        synchronized (pickedDocuments) {
            for (Uri uri : results) {
                if (uri == null) continue;
                DocumentInfo info = describe(uri);
                if (info == null) continue;
                pickedDocuments.put(documentKey(info.name, info.size), uri);
            }
            // 长时间使用不该无限增长；只保留最近 200 个文档。
            while (pickedDocuments.size() > 200) {
                Iterator<String> oldest = pickedDocuments.keySet().iterator();
                if (!oldest.hasNext()) break;
                oldest.next();
                oldest.remove();
            }
        }
    }

    private Uri takePickedUri(String name, long size) {
        synchronized (pickedDocuments) {
            Uri exact = pickedDocuments.remove(documentKey(name, size));
            if (exact != null) return exact;
            // 有些提供器给的 SIZE 是 -1，或者网页读到的是复制后的字节数，大小对不上
            // 就退回按文件名匹配（仍然只在这个 App 选择过的文档里找）。
            for (Iterator<Map.Entry<String, Uri>> iterator = pickedDocuments.entrySet().iterator(); iterator.hasNext(); ) {
                Map.Entry<String, Uri> entry = iterator.next();
                if (!entry.getKey().startsWith((name == null ? "" : name) + "@")) continue;
                iterator.remove();
                return entry.getValue();
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
            if (!isTrustedPage()) return "{\"canDelete\":false,\"pan123Login\":false,\"shareTarget\":false}";
            return "{\"canDelete\":true,\"pan123Login\":true,\"shareTarget\":true}";
        }

        /** 等待导入的分享文件列表：id / name / size。 */
        @JavascriptInterface
        public String sharedFiles() {
            if (!isTrustedPage()) return "[]";
            return sharedMetaJson();
        }

        /** 网页把这些文件读完并交给导入流程后，删掉 cache 里的副本。 */
        @JavascriptInterface
        public String releaseSharedFiles(String idsJson) {
            if (!isTrustedPage()) return "{\"released\":0}";
            // 同名方法在内部类里会解析到自己，必须显式限定到外部类，否则无限递归。
            MainActivity.this.releaseSharedFiles(idsJson);
            return "{\"released\":true}";
        }

        /**
         * 打开独立的 123 云盘登录页。结果通过 window.onRedGardenPan123Login
         * 回调回网页：参数是 [{token, source}] 的 JSON 字符串。
         */
        @JavascriptInterface
        public String openPan123Login() {
            if (!isTrustedPage()) return "{\"started\":false,\"reason\":\"当前页面不在受信任站点\"}";
            runOnUiThread(() -> {
                try {
                    startActivityForResult(new Intent(MainActivity.this, Pan123LoginActivity.class), PAN123_LOGIN_REQUEST);
                } catch (Exception error) {
                    Toast.makeText(MainActivity.this, "无法打开 123 云盘登录页", Toast.LENGTH_SHORT).show();
                }
            });
            return "{\"started\":true}";
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
