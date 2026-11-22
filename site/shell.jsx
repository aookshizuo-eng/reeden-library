import {BookOpen, PanelsTopLeft, Type, Bookmark, Upload, ListChecks, Settings, Ellipsis} from "lucide-react";
import {Button, Input, LibrarySearch, LibraryTools, LibraryPager, LibraryBulk} from "./ui";

export default function Shell() {
  return <>
    <div className="app-frame">
      <aside className="sidebar" aria-label="主导航">
        <div className="brand-mark"><span className="brand-glyph"><BookOpen size={18} aria-hidden="true" /></span><span>Red Garden</span></div>
        <p className="sidebar-note">Reeden 资源库</p>
        <nav className="nav-list">
          <button type="button" className="nav-item is-active" data-view="themes"><PanelsTopLeft size={17} aria-hidden="true" />主题库</button>
          <button type="button" className="nav-item" data-view="fonts"><Type size={17} aria-hidden="true" />字体库</button>
          <button type="button" className="nav-item" data-view="assets"><Bookmark size={17} aria-hidden="true" />收藏库</button>
          <button type="button" className="nav-item" data-view="import"><Upload size={17} aria-hidden="true" />导入文件</button>
          <button type="button" className="nav-item" data-view="jobs"><ListChecks size={17} aria-hidden="true" />后台任务 <span id="jobNavCount" className="nav-count" hidden></span></button>
          <button type="button" className="nav-item" data-view="storage"><Settings size={17} aria-hidden="true" />设置</button>
        </nav>
        <div className="sidebar-footer">
          <span className="status-dot"></span>
          <span id="runtimeModeLabel">本地处理模式</span>
        </div>
      </aside>

      <main className="sheet">
        <header className="topbar">
          <button className="mobile-menu" id="mobileMenu" aria-label="打开导航">菜单</button>
          <div className="crumbs"><BookOpen size={17} aria-hidden="true" /><strong id="topbarTitle">主题库</strong></div>
          <div className="top-actions">
            <Button id="addThemeButton"><Upload size={16} aria-hidden="true" />导入文件</Button>
          </div>
        </header>

        <p className="operation-status startup-error" id="startupError" role="alert" hidden></p>
        <section className="job-banner local-resume-panel" id="localResumePanel" aria-label="未完成上传" hidden><div><strong id="localResumeText"></strong><span id="localResumeNames"></span></div><div className="form-actions"><Button id="resumeLocalTransfers">继续上传</Button><Button id="discardLocalTransfers" variant="ghost">移除恢复副本</Button></div></section>
        <section className="job-banner" id="jobBanner" aria-label="后台任务进度" hidden>
          <div><strong id="jobBannerTitle">上传与恢复</strong><span id="jobBannerText"></span></div><button className="text-button" id="openJobs">查看任务</button>
        </section>

        <section className="view" id="importView" data-view-panel="import" hidden>
          <div className="title-row"><div><h1>导入文件</h1><p className="lede">选择文件后先查重，再确认入库。主题压缩在当前设备完成。</p></div><Button variant="outline" id="scanButton">导入清单</Button><input id="indexInput" type="file" accept=".json,application/json" hidden /></div>
          <p className="static-mode-note" id="staticModeNote" role="status" hidden></p>
          <div className="unified-import" aria-labelledby="unifiedDropTitle">
            <div className="drop-zone unified-drop-zone" id="unifiedDropZone" tabIndex="0" role="button" aria-label="拖入主题、字体或 SVG、HTML 文件">
              <span className="drop-icon">↓</span><strong id="unifiedDropTitle">把 ZIP、主题、字体或收藏文件拖到这里</strong><span>自动按后缀识别并分流</span><small>.zip · .red · .ttf · .otf · .woff · .woff2 · .svg · .html</small>
            </div>
            <div className="ingest-actions unified-actions"><button className="primary-button" id="chooseUnifiedFiles" type="button">选择文件</button><button className="secondary-button" id="chooseUnifiedFolder" type="button">选择文件夹</button><label className="check-label queue-later-label"><input id="queueForLater" type="checkbox" /><span>后台暂存：先上传原文件到共享库，之后在任意设备打开可继续压缩入库</span></label><label className="check-label queue-later-label"><input id="localCleanupEnabled" type="checkbox" /><span>清理本地文件：选择文件夹时申请写入权限，上传成功后再问你要不要删掉本地副本</span></label><label className="check-label queue-later-label"><input id="backupTo123" type="checkbox" /><span>同时备份到 123（可选，需先连接）</span></label></div>
            <p className="field-help cleanup-hint" id="localCleanupHint"></p>
            <input id="unifiedInput" type="file" accept=".zip,.red,.ttf,.otf,.woff,.woff2,.svg,.html,.htm,.txt" multiple hidden /><input id="unifiedFolderInput" type="file" accept=".zip,.red,.ttf,.otf,.woff,.woff2,.svg,.html,.htm,.txt" webkitdirectory="" multiple hidden />
            <p className="operation-status" id="archiveImportStatus" role="status" hidden></p>
            <p className="operation-status unified-import-status" id="unifiedImportStatus" role="status" hidden></p>
            <details className="import-issues" id="importIssues" hidden><summary id="importIssueSummary"></summary><ul id="importIssueList"></ul><Button id="retryImportIssues" variant="outline">重新读取未识别文件</Button></details>
          </div>
          <section className="transfer-progress" id="transferProgress" aria-live="polite" hidden>
            <div className="transfer-progress-head"><strong id="transferProgressTitle">正在处理</strong><span id="transferProgressCount">0 / 0</span><Button id="pauseTransfer" variant="outline" hidden>暂停，稍后继续</Button></div>
            <div className="transfer-track"><progress id="transferProgressBar" max="100" value="0" aria-label="上传与处理进度"></progress></div>
            <div className="transfer-progress-meta"><span id="transferProgressStage">等待开始</span><span id="transferProgressCurrent"></span><span id="transferElapsed"></span></div>
          </section>
          <div id="themeImportPane" role="tabpanel" aria-labelledby="themeImportTab">
            <section className="ingest-panel theme-ingest legacy-import-panel" aria-labelledby="ingestTitle">
              <div className="drop-zone" id="themeDropZone" tabIndex="0" role="button" aria-label="拖入 RED 主题文件">
                <span className="drop-icon">↓</span><strong>把 RED 主题拖到这里</strong><span>支持批量拖入 .red 文件</span><small>也可以点击选择文件</small>
              </div>
              <div className="ingest-copy"><h2 id="ingestTitle">加入待确认主题</h2><p>整批识别后，按名称和作者显示疑似重复与预览。确认所选后，在当前设备压缩、保存并同步。</p><div className="ingest-actions"><button className="primary-button" id="chooseThemes">选择 RED 文件</button><button className="secondary-button" id="chooseThemeFolder">选择主题文件夹</button><button className="text-button" id="indexThemeFolder">索引已有文件夹</button><input id="themeInput" type="file" accept=".red" multiple hidden /><input id="themeFolderInput" type="file" accept=".red" webkitdirectory="" multiple hidden /><input id="existingThemeFolderInput" type="file" accept=".red" webkitdirectory="" multiple hidden /></div><p className="ingest-note">日间素材优先；普通主题由当前设备压缩；加密主题由当前设备压缩图片后交给同步 Worker 认证重封。没有可用处理端时会明确提示并保留原包。</p></div>
            </section>
            <details className="compression-settings" id="compressionSettings"><summary>压缩设置<span id="compressionSettingsLabel">最大压缩</span><span className="field-help">展开调整</span></summary><section className="compression-panel" aria-labelledby="compressionTitle">
              <div className="compression-copy"><h2 id="compressionTitle">RED 图片压缩</h2><p>选择主题并确认后，在当前设备压缩图片、重新封包，再生成书架与书封预览。完成后按存储设置同步。</p><p className="field-help">透明图片保留透明度，动画保留原样；整包没有变小时保留原字节。加密 RED 的明文图片在手机和电脑都可先压缩；同步 Worker 负责认证清单、更新哈希并重新封包。</p></div>
              <div className="compression-controls" id="compressionPresetGroup" role="radiogroup" aria-label="压缩方案"><label className="preset-card"><input type="radio" name="compressionPreset" defaultValue="balanced" /><span className="preset-body"><strong>最高性价比</strong><span>静态图保留原尺寸，普通图片用 94% 画质 WebP，底栏在无损与有损结果里取更小的一张。GIF 保留尺寸、帧数和播放节奏，只合并非常接近的颜色。</span></span></label><label className="preset-card"><input type="radio" name="compressionPreset" defaultValue="max" defaultChecked /><span className="preset-body"><strong>最大压缩</strong><span>底栏 384 px，启动图、阅读背景与书架底 2560 px，其余静态图 1600 px，只缩小超过上限的图片；90% 画质 WebP，底栏逐张比较无损与有损。GIF 尺寸帧数不变，合并更多近似颜色。</span></span></label><label className="preset-card"><input type="radio" name="compressionPreset" defaultValue="custom" /><span className="preset-body"><strong>自选模式</strong><span>自己定编码方式、画质、长边上限和 GIF 处理，适合已知素材尺寸或想精确控制体积的主题。</span></span></label><div className="compression-custom" id="compressionCustomFields" hidden>
                <fieldset className="custom-group"><legend>静态图片编码</legend>
                  <label className="custom-choice"><input type="radio" name="compressionCodec" defaultValue="webp" defaultChecked /><span><strong>高画质 WebP</strong><small>有损编码，体积最小，画质可调。</small></span></label>
                  <label className="custom-choice"><input type="radio" name="compressionCodec" defaultValue="png" /><span><strong>无损 PNG</strong><small>不改像素，只按长边上限等比缩小；照片类通常压不动，会自动保留原图。</small></span></label>
                </fieldset>
                <div className="custom-row" id="compressionQualityRow"><span className="custom-label" id="compressionQualityLabel">画质</span>
                  <div className="range-row"><button type="button" className="range-step" id="compressionQualityDown" aria-label="降低画质">−</button><input id="compressionQuality" type="range" min="50" max="100" step="1" aria-labelledby="compressionQualityLabel" aria-describedby="compressionQualityHelp" defaultValue="95" /><button type="button" className="range-step" id="compressionQualityUp" aria-label="提高画质">+</button><output id="compressionQualityValue" htmlFor="compressionQuality">95%</output></div>
                  <p className="custom-help" id="compressionQualityHelp">仅对 WebP 有损编码生效，95% 以上基本看不出差别。</p>
                </div>
                <div className="custom-row"><label className="custom-label" htmlFor="compressionMaxEdge">静态图片最长边上限</label>
                  <select id="compressionMaxEdge" aria-describedby="compressionMaxEdgeHelp" defaultValue="0"><option value="0">保持原尺寸</option><option value="2560">2560 px</option><option value="1920">1920 px</option><option value="1600">1600 px</option><option value="1280">1280 px</option><option value="1024">1024 px</option></select>
                  <p className="custom-help" id="compressionMaxEdgeHelp">超出时等比缩小；GIF 保持尺寸与帧数。</p>
                </div>
                <div className="custom-row"><label className="custom-label" htmlFor="compressionGifColors">GIF 处理</label>
                  <select id="compressionGifColors" aria-describedby="compressionGifColorsHelp"><option value="0">仅无损重编码（GIF 保持原样）</option><option value="256">量化到 256 色</option><option value="128">量化到 128 色</option><option value="64">量化到 64 色</option></select>
                  <p className="custom-help" id="compressionGifColorsHelp">量化只合并颜色，尺寸、帧数和播放节奏不变。</p>
                </div>
                <label className="custom-check"><input type="checkbox" id="compressionReader" defaultChecked /><span>同时压缩阅读背景</span></label>
                <label className="custom-check"><input type="checkbox" id="compressionIconLossless" defaultChecked /><span>底栏图标在无损与有损结果里取更小的一张</span></label>
              </div></div>
            </section></details>
          <section className="review-area" id="reviewArea" hidden>
            <div className="section-heading"><div><h2>待处理与确认</h2><p>主题会压缩图片并重新封包（加密包保持清单、权限与资源哈希有效）；字体和收藏先停在这里，勾选后和主题一起上传。同步 Worker 不可用时会保留原包并说明原因。</p></div><span className="review-count" id="reviewCount">0</span></div>
            <div className="bulk-toolbar" id="reviewToolbar"><label className="select-label"><input type="checkbox" id="selectAllReview" />全选</label><span className="selection-count" id="reviewSelectedCount">已选 0 项</span><Button id="selectDuplicateImports" variant="outline">选中重复（0）</Button><Button id="removeSelectedImports" variant="destructive" disabled>移除所选</Button><button className="primary-button" id="commitSelectedThemes" type="button" disabled>确认所选并压缩保存</button><span className="bulk-status" id="reviewBatchStatus" role="status"></span></div>
            <p className="compression-plan" id="compressionPlan" role="status"></p>
            <div id="reviewList" className="review-list"></div>
            <div id="pendingList" className="pending-list" hidden></div>
          </section>

            <section className="import-results" id="themeImportResults" hidden><div className="section-heading"><div><h2>本批压缩与保存结果</h2><p>处理完成后显示压缩前后大小与节省比例。</p></div><button className="text-button" data-open-view="themes">查看主题库</button></div><div id="themeImportJobs" className="job-list"></div><div id="themeCompressionResults" className="compression-results"></div></section>
          </div>
          <div id="fontImportPane" role="tabpanel" aria-labelledby="fontImportTab">
            <section className="ingest-panel font-ingest legacy-import-panel">
              <div className="drop-zone" id="fontDropZone" tabIndex="0" role="button" aria-label="拖入字体文件"><span className="drop-icon">Aa</span><strong>把字体文件拖到这里</strong><span>TTF、OTF、WOFF、WOFF2</span><small>也可以点击选择文件</small></div>
              <div className="ingest-copy"><h2>加入新字体</h2><p>按 SHA-256 检查本地与云端已有库，重复跳过。新字体自动收录并同步 R2。</p><div className="ingest-actions"><button className="primary-button" id="chooseFonts">选择字体文件</button><button className="secondary-button" id="chooseFontFolder">选择字体文件夹</button><input id="fontInput" type="file" accept=".ttf,.otf,.woff,.woff2" multiple hidden /><input id="fontFolderInput" type="file" accept=".ttf,.otf,.woff,.woff2" webkitdirectory="" multiple hidden /></div><p className="ingest-note">原字体不压缩，只保留字形预览、名称和索引信息。选择后先进入待处理，统一确认才上传。</p></div>
            </section>
            <p className="operation-status ingest-status" id="fontImportStatus" role="status" hidden></p>
            <section className="import-results" id="fontImportResults" hidden><div className="section-heading"><div><h2>本批字体</h2><p id="fontBatchDescription">收录成功后这里会自动清空，字体保存在字体库。</p></div><button className="text-button" data-open-view="fonts">查看字体库</button></div><div id="importedFontList" className="font-list"></div></section>
          </div>
          <div id="assetImportPane" role="tabpanel" aria-labelledby="assetImportTab">
            <section className="ingest-panel asset-ingest legacy-import-panel">
              <div className="drop-zone" id="assetDropZone" tabIndex="0" role="button" aria-label="拖入 SVG 或 HTML 文件"><span className="drop-icon"><Bookmark size={20} aria-hidden="true" /></span><strong>把 SVG / HTML 拖到这里</strong><span>支持批量收藏 .svg、.html、.htm</span><small>也可以点击选择文件</small></div>
              <div className="ingest-copy"><h2>加入收藏</h2><p>原文件按 SHA-256 去重并保存到共享 R2。每个收藏可补充作者、风格和标签，之后按分类快速筛选。</p><div className="ingest-actions"><button className="primary-button" id="chooseAssets">选择 SVG / HTML / TXT</button><button className="secondary-button" id="chooseAssetFolder">选择收藏文件夹</button><input id="assetInput" type="file" accept=".svg,.html,.htm,.txt,image/svg+xml,text/html,text/plain" multiple hidden /><input id="assetFolderInput" type="file" accept=".svg,.html,.htm,.txt,image/svg+xml,text/html,text/plain" webkitdirectory="" multiple hidden /></div><p className="ingest-note">SVG 使用安全图片预览；HTML 使用无权限 sandbox 预览，不会在收藏库页面执行脚本。</p></div>
            </section>
            <p className="operation-status ingest-status" id="assetImportStatus" role="status" hidden></p>
            <section className="import-results" id="assetImportResults" hidden><div className="section-heading"><div><h2>本批收藏</h2><p id="assetBatchDescription">收录成功后这里会自动清空，收藏保存在收藏库。</p></div><button className="text-button" data-open-view="assets">查看收藏库</button></div><div id="importedAssetList" className="asset-list"></div></section>
          </div>
        </section>

        <section className="view" id="themesView" data-view-panel="themes" hidden>
          <div className="title-row catalog-title"><div><h1 tabIndex={-1}>主题库</h1><p className="lede">预览和下载 Reeden 主题。</p></div><div className="title-meta"><span id="themeCount" aria-live="polite">正在读取…</span><span id="storageHint" hidden></span></div></div>
          <section className="library-area">
            <LibrarySearch id="themeSearchInput" label="搜索主题" placeholder="搜索主题名称、作者或类别" />
            <LibraryTools kind="theme" refreshId="refreshThemes">
              <select className="catalog-select" id="themeCategoryFilter" aria-label="按类别筛选主题"><option value="all">全部类别</option></select>
              <select className="catalog-select" id="themeAuthorFilter" aria-label="按作者筛选主题"><option value="all">全部作者</option></select>

            </LibraryTools>
            <p className="cache-info" data-cache-info></p>
            <p className="catalog-status" data-library-status="theme" role="status">正在读取主题…</p>
            <LibraryBulk kind="theme" />
            <div id="themeList" className="theme-list catalog-grid theme-list"></div>
            <LibraryPager kind="theme" />
            <div className="empty-state" id="themeEmpty" hidden>
              <h3>还没有已收录主题</h3>
              <p>导入一个 .red 文件开始。</p><Button variant="outline" data-library-empty="theme">导入文件</Button>
            </div>
          </section>
        </section>


        <section className="view" id="fontsView" data-view-panel="fonts" hidden>
          <div className="title-row catalog-title"><div><h1 tabIndex={-1}>字体库</h1><p className="lede">通过样张挑选适合阅读的字体。</p></div><div className="title-meta"><span id="fontCount" aria-live="polite">正在读取…</span></div></div>
          <section className="font-area">
            <LibrarySearch id="fontSearchInput" label="搜索字体" placeholder="搜索字体、作者或标签" />
            <LibraryTools kind="font" refreshId="refreshFonts"><select className="catalog-select" id="fontCategoryFilters" aria-label="字体分类"><option value="all">全部分类</option></select></LibraryTools>
            <p className="cache-info" data-cache-info></p>
            <p className="catalog-status" data-library-status="font" role="status">正在读取字体…</p>
            <LibraryBulk kind="font" /><div id="fontList" className="theme-list catalog-grid font-list"></div><LibraryPager kind="font" /><div className="empty-state" id="fontEmpty" hidden><h3>还没有字体</h3><p>从单个文件或文件夹开始建立字体索引。</p><Button variant="outline" data-library-empty="font">导入文件</Button></div>
          </section>
        </section>

        <section className="view" id="assetsView" data-view-panel="assets" hidden>
          <div className="title-row catalog-title"><div><h1 tabIndex={-1}>收藏库</h1><p className="lede">浏览已收藏的 SVG、HTML，以及归类到「图集 / 高亮」的 RED 包。</p></div><div className="title-meta"><span id="assetCount" aria-live="polite">正在读取…</span></div></div>
          <section className="asset-area">
            <LibrarySearch id="assetSearchInput" label="搜索收藏" placeholder="搜索名称、作者或标签" />
            <LibraryTools kind="asset" refreshId="refreshAssets">
              <select className="catalog-select" id="assetCategoryFilter" aria-label="收藏筛选"><option value="all">全部收藏</option><optgroup label="类型"><option value="svg">SVG</option><option value="html">HTML</option><option value="red">主题部件</option></optgroup><optgroup label="主题部件"><option value="gallery">封面图集</option><option value="highlight">高亮包</option></optgroup><optgroup label="分类"><option value="ungrouped">未分类</option><option value="author">已填写作者</option><option value="style">已填写风格</option></optgroup></select>

            </LibraryTools>
            <p className="cache-info" data-cache-info></p>
            <p className="catalog-status" data-library-status="asset" role="status">正在读取收藏…</p>
            <LibraryBulk kind="asset" />
            <div id="assetList" className="theme-list catalog-grid asset-list"></div>
            <LibraryPager kind="asset" />
            <div className="empty-state" id="assetEmpty" hidden><h3>还没有收藏</h3><p>导入 SVG、HTML，或加入 RED 图集 / 高亮包开始。</p><Button variant="outline" data-library-empty="asset">导入文件</Button></div>
          </section>
        </section>


        <section className="view" id="jobsView" data-view-panel="jobs" hidden>
          <div className="title-row"><div><h1>上传与恢复</h1><p className="lede">普通上传的未完成文件保存在本设备；云端暂存文件可跨设备继续。每个文件成功后记录进度，关闭网页会暂停当前设备的处理。</p></div><button className="text-button" id="refreshJobs">刷新任务</button></div>
          <div className="form-actions"><button className="secondary-button" id="resumeStagedJobs" type="button">继续处理暂存文件</button><button className="text-button" id="clearFinishedJobs" type="button">清除已完成任务</button><label className="check-label queue-later-label"><input id="autoResumeQueue" type="checkbox" /><span>打开页面时自动继续云端排队的批次</span></label></div>
          <p className="operation-status" id="jobsStatus" role="status"></p><div id="jobList" className="job-list"></div><div className="empty-state" id="jobsEmpty"><h2>暂时没有后台任务</h2><p>确认主题或同步资产后，这里会显示进度和结果。</p></div>
        </section>

        <section className="view settings-view" id="storageView" data-view-panel="storage" hidden>
          <div className="title-row"><div><h1 tabIndex={-1}>设置</h1><p className="lede">管理资源库连接、备份和设备。</p></div><div className="title-meta"><span id="storageState">正在读取配置</span></div></div>
          <div className="settings-stack">
            <section className="settings-section">
              <div className="settings-section-heading"><h2>资源库连接</h2><p id="storageDestination">主题、字体和收藏共用一个私有库。</p></div>
              <div className="settings-content"><p className="operation-status" id="apiBaseStatus" role="status"></p>
                <details className="settings-disclosure" id="connectionDetails"><summary>修改连接</summary><div className="settings-fields static-api-panel">
                  <label>同步地址<Input id="apiBaseInput" type="url" inputMode="url" placeholder="https://red-garden-sync.pages.dev" autoComplete="off" spellCheck="false" /></label>
                  <label>访问口令<Input id="syncTokenInput" type="password" placeholder="私有库的访问口令" autoComplete="off" spellCheck="false" /></label>
                  <div className="form-actions"><Button id="saveApiBase">保存并连接</Button><Button id="clearApiBase" variant="ghost">恢复默认地址</Button></div>
                </div></details>
              </div>
            </section>
            <details className="settings-section settings-disclosure" id="deviceTransferDetails"><summary><span>连接其他设备<small>通过加密链接或文件迁移配置</small></span></summary>
              <form className="settings-fields" id="deviceTransferForm">
                <div className="density-toggle transfer-direction" role="group" aria-label="设备迁移方式"><Button variant="ghost" data-transfer-direction="export" aria-pressed="true">在新设备使用</Button><Button variant="ghost" data-transfer-direction="import" aria-pressed="false">导入已有配置</Button></div>
                <label>迁移口令<Input type="password" name="passphrase" minLength={8} autoComplete="new-password" placeholder="至少 8 位；两台设备使用相同口令" required /></label>
                <div data-transfer-panel="export"><label className="check-label"><input type="checkbox" name="include123" /><span>同时迁移 123 登录</span></label><div className="form-actions"><Button type="submit" value="link">生成接入链接</Button><Button type="submit" value="export" variant="outline">导出配置文件</Button></div></div>
                <div data-transfer-panel="import" hidden><label id="deviceConfigFileLabel">加密配置文件<input type="file" name="configFile" accept=".json" /></label><div className="form-actions"><Button type="submit" value="import">导入并连接</Button></div></div>
                <label id="deviceLinkLabel" hidden>接入链接<Input id="deviceConnectLink" readOnly onFocus={event=>event.target.select()} /></label>
                <p className="field-help">请将迁移口令与链接或文件分开传送。</p>
                <details className="settings-disclosure"><summary>云端配置副本</summary><p className="field-help">仅已连接的设备可用。新设备请使用链接或文件。</p><div className="form-actions"><Button type="submit" value="cloud-save" variant="outline">保存到云端</Button><Button type="submit" value="cloud-load" variant="outline">从云端恢复</Button></div></details>
                <p className="operation-status" id="deviceTransferStatus" role="status"></p>
              </form>
            </details>
            <section className="settings-section" id="pan123Settings">
              <div className="settings-section-heading" id="pan123Label"><h2>123 云盘备份</h2><p>可选：额外备份原始 RED。</p><span id="pan123CredentialState" hidden></span></div>
              <div className="settings-content" id="pan123Panel">
                <label className="settings-switch" id="settings123ToggleRow"><span><strong>备份原始 RED</strong><small id="pan123SettingsSummary">已关闭</small></span><input id="settingsBackup123Enabled" type="checkbox" role="switch" /></label>
                <div className="settings-fields" id="pan123BackupControls" hidden>
                  <label>备份目录<Input id="pan123BackupFolder" spellCheck="false" defaultValue="Red-Garden-Backup" /></label>
                  <div className="form-actions"><Button id="verifyPan123Backup" variant="outline">检查连接</Button><Button id="listPan123Backup" variant="outline">查看备份</Button><Button id="retryPan123Backups" variant="outline">重试待备份</Button></div>
                  <p className="operation-status" id="pan123BackupStatus" role="status"></p><div className="backup-inventory" id="pan123BackupList" aria-live="polite"></div>
                  <details className="settings-disclosure" id="pan123LoginDetails"><summary>连接或重新登录</summary><div className="settings-fields">
                    <div className="qr-login"><Button id="startPan123Qr" variant="outline">扫码登录</Button><div className="qr-login-code" id="pan123QrCode" hidden><div className="qr-host" id="pan123QrHost"></div><Button id="stopPan123Qr" variant="ghost">取消扫码</Button></div><p className="operation-status" id="pan123QrStatus" role="status"></p></div>
                    <div id="pan123BrowserLoginMethods"><details className="settings-disclosure"><summary>其他登录方式</summary><div className="settings-fields">
                      <form id="pan123QuickLogin" autoComplete="off"><div className="field-pair"><label>账号<Input name="username" autoComplete="username" autoCapitalize="none" spellCheck="false" placeholder="手机号或邮箱" required /></label><label>密码<Input name="password" type="password" autoComplete="current-password" required /></label></div><div className="form-actions"><Button type="submit" id="pan123QuickLoginButton">登录</Button><Button id="pan123WebLogin" variant="ghost">网页登录</Button></div><p className="field-help" id="pan123WebLoginHint">遇到验证码时，请到官方网页完成验证。</p></form>
                      <details className="settings-disclosure" id="pan123TokenDetails"><summary>使用已有会话</summary><div className="settings-fields"><label>会话 Token<Input id="pan123BackupToken" type="password" autoComplete="off" spellCheck="false" placeholder="填写 Bearer 后的内容" /></label><Button id="pan123PasteToken" variant="outline">从剪贴板粘贴</Button><p className="field-help" id="pan123PasteHint">填写后自动保存。</p></div></details>
                    </div></details></div>
                    <div id="pan123LocalLoginMethods" hidden><details className="session-fallback" id="pan123PasswordDetails"><summary>使用账号密码登录</summary><div className="session-fallback-content"><form id="pan123LoginForm" className="credential-form" autoComplete="off">
                <div className="field-pair"><label>123 云盘账号<input name="username" autoComplete="off" autoCapitalize="none" spellCheck="false" required aria-describedby="pan123LoginHelp" /></label><label>登录密码<input name="password" type="password" autoComplete="new-password" spellCheck="false" required aria-describedby="pan123LoginHelp" /></label></div>

                <div className="form-actions"><button className="secondary-button" type="submit">登录并保存会话</button></div>
              </form></div></details>
              <details className="session-fallback" id="pan123SessionDetails"><summary>登录需要验证码？使用已有会话</summary><div className="session-fallback-content"><form id="pan123SessionForm" className="credential-form" autoComplete="off"><label>会话 Token<input name="token" type="password" autoComplete="new-password" spellCheck="false" required aria-describedby="pan123TokenHelp" /></label><div className="form-actions"><button className="secondary-button" type="submit">保存会话</button></div></form></div></details>
</div>
                    <p className="operation-status" id="pan123Status" role="status"></p>
                  </div></details>
                  <details className="settings-disclosure"><summary>连接排查</summary><div className="settings-fields"><div className="form-actions"><Button id="verifyPan123Write" variant="outline">测试备份写入</Button><Button id="copyPan123Diagnostics" variant="outline">复制诊断</Button><a className="download-link" href="https://www.123pan.com/" target="_blank" rel="noreferrer">前往官方网页</a><Button id="clearPan123Backup" variant="ghost">断开连接</Button></div><p className="field-help">写入测试会在 _verify/ 中保留一个约 40 B 的测试文件。</p><pre id="pan123Diagnostics" className="diagnostic-output" hidden></pre><div id="pan123ProbeBlock" hidden><p className="field-help" id="pan123ProbeHelp"></p><Button id="probePan123" variant="outline">测试本机备份</Button></div></div></details>
                </div>
              </div>
            </section>
            <details className="settings-section settings-disclosure" id="maintenanceDetails"><summary><span>高级与维护<small>存储详情、手动同步和历史清理</small></span></summary><div className="settings-fields">
              <div id="storageInventory" className="storage-inventory" aria-live="polite"></div>
              <div className="form-actions"><Button id="pullStorage" variant="outline">刷新云端清单</Button><Button id="syncStorage" variant="outline">同步本地文件</Button></div><p className="operation-status" id="storageOperation" role="status"></p><div id="storageUnindexed" hidden></div>
              <details className="settings-disclosure"><summary>清理历史文件</summary><p className="field-help">先核对再删除。正在使用或未满 7 天的文件会保留。</p><div className="form-actions"><Button id="maintenancePlan" variant="outline">检查可清理文件</Button><Button id="maintenanceDelete" variant="destructive" hidden>删除已核对文件</Button></div><p className="operation-status" id="maintenanceStatus" role="status"></p><pre id="maintenanceList" className="diagnostic-output"></pre></details>
              <details className="settings-disclosure" id="localStorageSettings" hidden><summary>本机后端存储</summary><div id="r2SettingsLabel"><p id="credentialState"></p></div><form className="settings-panel" id="storageForm" autoComplete="off">
              <p className="operation-status" id="storageBusyNote" hidden>后台任务正在使用当前存储位置，完成后可修改配置。</p>
              <label>资产存储<select name="libraryProvider"><option value="local">仅本地文件夹</option><option value="cloudflare_r2">Cloudflare R2（S3 兼容）</option></select></label>
              <div id="r2Fields" className="storage-fields">
                <div className="field-pair"><div className="field-group"><label>Cloudflare Account ID<input name="accountId" placeholder="32 位 Account ID" aria-describedby="accountIdHelp" spellCheck="false" /></label><p className="field-help" id="accountIdHelp">在 Cloudflare 控制台复制 Account ID。</p></div><div className="field-group"><label>Bucket 名称<input name="bucket" placeholder="你的 R2 Bucket 名称" aria-describedby="bucketHelp" spellCheck="false" /></label><p className="field-help" id="bucketHelp">填写已有存储桶的名称。</p></div></div>
                <label>S3 Endpoint（可选）<input name="endpoint" type="url" placeholder="https://<ACCOUNT_ID>.r2.cloudflarestorage.com" aria-describedby="endpointHelp" spellCheck="false" /></label><p className="field-help" id="endpointHelp">普通 Bucket 留空即可。</p>
                <label>库目录前缀<input name="rootPath" placeholder="reeden-library" aria-describedby="rootPathHelp" spellCheck="false" /></label><p className="field-help" id="rootPathHelp">默认 reeden-library；文件在根目录时留空。</p>
                <div className="field-pair"><label>Access Key ID<input name="accessKeyId" type="password" autoComplete="off" spellCheck="false" aria-describedby="r2KeyHelp" /></label><label>Secret Access Key<input name="secretAccessKey" type="password" autoComplete="off" spellCheck="false" aria-describedby="r2KeyHelp" /></label></div>
                <p className="field-help" id="r2KeyHelp">使用 R2 的 S3 密钥对；已有凭据时留空保留。</p>
                <label className="check-label"><input name="autoSync" type="checkbox" /><span>主题确认或字体导入后，自动同步到 R2</span></label>
              </div>
              <div className="archive-fields">
                <h3>原始 RED 备份</h3>
                <label>原始包存储<select name="archiveProvider"><option value="local">本地单独保存</option><option value="r2_library">R2 原包目录（复用上方连接）</option><option value="123pan">123 云盘（网页协议）</option><option value="123pan_webdav">旧配置：123 WebDAV（需自行提供服务）</option></select></label>
                <label>备份目录<input name="archiveRootPath" placeholder="originals" spellCheck="false" aria-describedby="archiveHint" /></label>
                <label id="archiveEndpointField" hidden>旧 WebDAV 服务地址<input name="archiveEndpoint" type="url" placeholder="https://你的-webdav-endpoint/" spellCheck="false" /></label>
                <p className="field-help" id="archiveHint">原始 RED 单独保存。</p>
                <label className="check-label"><input name="cloudOnly" type="checkbox" aria-describedby="cloudOnlyHelp" /><span>上传核验后，清理本机处理副本</span></label>
                <p className="field-help" id="cloudOnlyHelp">上传并核验后清理应用内副本，原始文件夹不受影响。</p>
              </div>
              <div className="form-actions"><button className="primary-button" type="submit">保存配置</button><button className="secondary-button" id="testStorage" type="button">测试 R2 连接</button><button className="text-button" id="testArchive" type="button">测试归档连接</button></div>
              <p className="operation-status" id="configStatus" role="status">保存后请测试连接。</p>
            </form></details>
            </div></details>
          </div>
        </section>

        <footer className="app-footer"><span>Red Garden · 设备本地处理 / R2 同步</span><span>资源用途依据 `.red` 内实际绑定判定</span></footer>
      </main>
    </div>

    <nav className="mobile-tabs" aria-label="主要页面">
      <button className="tab-item" type="button" data-tab="import"><Upload className="tab-icon" size={18} aria-hidden="true" /><span>导入</span></button>
      <button className="tab-item is-active" type="button" data-tab="themes"><PanelsTopLeft className="tab-icon" size={18} aria-hidden="true" /><span>主题</span></button>
      <button className="tab-item" type="button" data-tab="fonts"><Type className="tab-icon" size={18} aria-hidden="true" /><span>字体</span></button>
      <button className="tab-item" type="button" data-tab="assets"><Bookmark className="tab-icon" size={18} aria-hidden="true" /><span>收藏</span></button>
      <button className="tab-item" type="button" data-tab="more" aria-expanded="false" aria-controls="mobileMore"><Ellipsis className="tab-icon" size={18} aria-hidden="true" /><span>更多</span></button>
    </nav>
    <div className="mobile-more" id="mobileMore" hidden>
      <p className="more-hint"><span id="moreRuntimeMode">本地处理模式</span></p>
      <button type="button" data-more-view="jobs">上传与恢复<span className="nav-count" id="moreJobCount" hidden></span></button>
      <button type="button" data-more-view="storage">设置</button>
      <button type="button" data-more-action="refresh">刷新当前库</button>
    </div>

    <div className="toast" id="toast" role="status" aria-live="polite"></div>
    <dialog className="preview-dialog" id="previewDialog" aria-labelledby="previewDialogTitle" aria-describedby="previewDialogDescription"><div className="preview-dialog-head"><h2 id="previewDialogTitle">主题预览</h2><button className="icon-button" id="closePreviewDialog" type="button" aria-label="关闭预览">×</button></div><p className="preview-description" id="previewDialogDescription"></p><img id="previewDialogImage" alt="主题预览" /></dialog>
    <dialog className="theme-dialog" id="themeDialog" aria-labelledby="themeDialogTitle"><div className="theme-dialog-head"><div><h2 id="themeDialogTitle">主题细节</h2><p id="themeDialogSub"></p></div><button className="icon-button" id="closeThemeDialog" type="button" aria-label="关闭">×</button></div><div className="theme-dialog-body" id="themeDialogBody"></div></dialog>
    <dialog className="theme-dialog" id="bulkTagDialog" aria-labelledby="bulkTagTitle">
      <div className="theme-dialog-head"><h2 id="bulkTagTitle">批量标签</h2><button type="button" className="icon-button" id="closeBulkTags" aria-label="关闭">×</button></div>
      <form className="theme-dialog-body" id="bulkTagForm">
        <label>修改方式<select name="mode" defaultValue="add"><option value="add">添加，保留原标签</option><option value="remove">移除指定标签</option><option value="replace">替换全部标签</option><option value="auto">按每项类别与格式自动补标签</option></select></label>
        <label>标签<input name="tags" placeholder="多个标签用中文或英文逗号分隔" /></label>
        <p className="field-help">自动补标签使用每项已有信息，无需输入标签。替换模式留空会清空标签。</p>
        <p id="bulkTagStatus" className="operation-status" role="status"></p>
        <Button type="submit">应用到已选资源</Button>
      </form>
    </dialog>
    <dialog className="theme-dialog bulk-category-dialog" id="bulkCategoryDialog" aria-labelledby="bulkCategoryTitle"><div className="theme-dialog-head"><div><h2 id="bulkCategoryTitle">批量修改类别</h2><p id="bulkCategorySub"></p></div><button className="icon-button" id="closeBulkCategory" type="button" aria-label="关闭">×</button></div><div className="theme-dialog-body"><div className="bulk-category-mode" role="radiogroup" aria-label="处理方式"><label><input type="radio" name="bulkCategoryMode" defaultValue="add" defaultChecked /><span>添加类别（保留原有）</span></label><label><input type="radio" name="bulkCategoryMode" defaultValue="replace" /><span>替换为所选类别</span></label></div><div className="bulk-category-picks" id="bulkCategoryPicks"></div><div className="theme-category-add"><input id="bulkCategoryInput" type="text" maxLength="16" placeholder="新类别，例如 深色护眼" aria-label="新建主题类别" /><button className="text-button" id="bulkCategoryAdd" type="button">加入</button></div><p className="field-help">勾选要写入的类别，再点下面的按钮。选择「替换」时，原有分类会被覆盖，可以一个都不选来清空。</p><div className="modal-actions"><button className="secondary-button" id="bulkCategoryCancel" type="button">取消</button><button className="primary-button" id="bulkCategoryApply" type="button">应用到 0 个主题</button></div></div></dialog>
    <dialog className="theme-dialog bulk-category-dialog" id="bulkAuthorDialog" aria-labelledby="bulkAuthorTitle"><div className="theme-dialog-head"><div><h2 id="bulkAuthorTitle">批量修改作者</h2><p id="bulkAuthorSub"></p></div><button className="icon-button" id="closeBulkAuthor" type="button" aria-label="关闭">×</button></div><div className="theme-dialog-body"><label>作者名<input id="bulkAuthorInput" type="text" maxLength="40" placeholder="输入新的作者名" aria-label="作者名" /></label><p className="field-help">只改作者，作品名、类别和标签保持原样。留空会把作者写成「作者未记录」。</p><div className="modal-actions"><button className="secondary-button" id="bulkAuthorCancel" type="button">取消</button><button className="primary-button" id="bulkAuthorApply" type="button">应用到 0 个主题</button></div></div></dialog>
    <dialog className="preview-dialog" id="removeImportDialog" aria-labelledby="removeImportTitle"><div className="preview-dialog-head"><h2 id="removeImportTitle">移除待导入文件</h2><Button id="closeRemoveImport" variant="ghost" aria-label="关闭">×</Button></div><p id="removeImportDescription"></p><p className="field-help">选择移除方式；本地清理需要浏览器授权。ZIP 原包保留。</p><div className="modal-actions"><Button id="removeImportCancel" variant="outline">取消</Button><Button id="removeImportConfirm" variant="outline">仅移出列表</Button><Button id="removeImportWithLocal" variant="destructive">移除并清理本地</Button></div></dialog>
          <dialog className="preview-dialog record-dialog" id="recordDialog" aria-labelledby="recordDialogTitle"><div className="preview-dialog-head"><div><h2 id="recordDialogTitle"></h2><p className="preview-description" id="recordDialogDescription"></p></div><Button variant="ghost" id="closeRecordDialog" aria-label="关闭">×</Button></div><div id="recordDialogBody" className="record-dialog-body"></div></dialog>
<dialog className="preview-dialog cleanup-dialog" id="cleanupDialog" aria-labelledby="cleanupDialogTitle" aria-describedby="cleanupDialogDescription"><div className="preview-dialog-head"><div><h2 id="cleanupDialogTitle">删除本地文件</h2><p className="preview-description" id="cleanupDialogDescription"></p></div><button className="icon-button" id="closeCleanupDialog" type="button" aria-label="关闭">×</button></div><div className="cleanup-toolbar"><label className="check-label"><input id="cleanupSelectAll" type="checkbox" defaultChecked /><span id="cleanupSelectAllLabel">全选</span></label><span id="cleanupSummary" role="status"></span></div><ul className="cleanup-list" id="cleanupList"></ul><p className="cleanup-note" id="cleanupNote" role="status">批量删除只需授权一次所在文件夹；删除前会核对每个文件的内容。</p><div className="modal-actions"><button className="secondary-button" id="cleanupCancel" type="button">保留文件</button><button className="primary-button" id="cleanupConfirm" type="button">删除所选</button></div></dialog>
    <div className="modal-backdrop" id="modalBackdrop" hidden><section className="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle"><div className="modal-head"><div><h2 id="modalTitle">确认主题</h2><p id="modalSubtitle">查看候选后再保存。</p></div><button className="icon-button" id="closeModal" aria-label="关闭">×</button></div><div id="modalBody"></div></section></div>
  </>;
}
