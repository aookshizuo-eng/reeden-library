import {BookOpen, PanelsTopLeft, Type, Bookmark, Upload, ListChecks, Settings, Ellipsis} from "lucide-react";
import {Button, Input, LibrarySearch, LibraryTools, LibraryPager} from "./ui";

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
          <button type="button" className="nav-item" data-view="storage"><Settings size={17} aria-hidden="true" />存储设置</button>
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
            <div className="ingest-actions unified-actions"><button className="primary-button" id="chooseUnifiedFiles" type="button">选择文件</button><button className="secondary-button" id="chooseUnifiedFolder" type="button">选择文件夹</button><label className="check-label queue-later-label"><input id="queueForLater" type="checkbox" /><span>后台暂存：先上传原文件到共享库，之后在任意设备打开可继续压缩入库</span></label><label className="check-label queue-later-label"><input id="localCleanupEnabled" type="checkbox" /><span>清理本地文件：选择文件夹时申请写入权限，上传成功后再问你要不要删掉本地副本</span></label></div>
            <p className="field-help cleanup-hint" id="localCleanupHint"></p>
            <input id="unifiedInput" type="file" accept=".zip,.red,.ttf,.otf,.woff,.woff2,.svg,.html,.htm" multiple hidden /><input id="unifiedFolderInput" type="file" accept=".zip,.red,.ttf,.otf,.woff,.woff2,.svg,.html,.htm" webkitdirectory="" multiple hidden />
            <p className="operation-status" id="archiveImportStatus" role="status" hidden></p>
            <p className="operation-status unified-import-status" id="unifiedImportStatus" role="status" hidden></p>
          </div>
          <section className="transfer-progress" id="transferProgress" aria-live="polite" hidden>
            <div className="transfer-progress-head"><strong id="transferProgressTitle">正在处理</strong><span id="transferProgressCount">0 / 0</span></div>
            <progress id="transferProgressBar" max="100" value="0" aria-label="上传与处理进度"></progress>
            <div className="transfer-progress-meta"><span id="transferProgressStage">等待开始</span><span id="transferProgressCurrent"></span></div>
          </section>
          <div id="themeImportPane" role="tabpanel" aria-labelledby="themeImportTab">
            <section className="ingest-panel theme-ingest legacy-import-panel" aria-labelledby="ingestTitle">
              <div className="drop-zone" id="themeDropZone" tabIndex="0" role="button" aria-label="拖入 RED 主题文件">
                <span className="drop-icon">↓</span><strong>把 RED 主题拖到这里</strong><span>支持批量拖入 .red 文件</span><small>也可以点击选择文件</small>
              </div>
              <div className="ingest-copy"><h2 id="ingestTitle">加入待确认主题</h2><p>整批识别后，按名称和作者显示疑似重复与预览。确认所选后，在当前设备压缩、保存并同步。</p><div className="ingest-actions"><button className="primary-button" id="chooseThemes">选择 RED 文件</button><button className="secondary-button" id="chooseThemeFolder">选择主题文件夹</button><button className="text-button" id="indexThemeFolder">索引已有文件夹</button><input id="themeInput" type="file" accept=".red" multiple hidden /><input id="themeFolderInput" type="file" accept=".red" webkitdirectory="" multiple hidden /><input id="existingThemeFolderInput" type="file" accept=".red" webkitdirectory="" multiple hidden /></div><p className="ingest-note">日间素材优先；普通主题由当前设备压缩；加密主题由当前设备压缩图片后交给同步 Worker 认证重封。没有可用处理端时会明确提示并保留原包。</p></div>
            </section>
            <section className="compression-panel" aria-labelledby="compressionTitle">
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
            </section>
          <div className="transfer-progress review-progress" id="reviewProgress" aria-live="polite" hidden>
            <div className="transfer-progress-head"><strong id="reviewProgressTitle">正在处理</strong><span id="reviewProgressCount">0 / 0</span></div>
            <progress id="reviewProgressBar" max="100" value="0" aria-label="本批主题处理进度"></progress>
            <div className="transfer-progress-meta"><span id="reviewProgressStage">等待开始</span><span id="reviewProgressCurrent"></span></div>
          </div>
          <section className="review-area" id="reviewArea" hidden>
            <div className="section-heading"><div><h2>待处理与确认</h2><p>主题会压缩图片并重新封包（加密包保持清单、权限与资源哈希有效）；字体和收藏先停在这里，勾选后和主题一起上传。同步 Worker 不可用时会保留原包并说明原因。</p></div><span className="review-count" id="reviewCount">0</span></div>
            <div className="bulk-toolbar" id="reviewToolbar"><label className="select-label"><input type="checkbox" id="selectAllReview" />全选</label><span className="selection-count" id="reviewSelectedCount">已选 0 项</span><button className="primary-button" id="commitSelectedThemes" type="button" disabled>确认所选并压缩保存</button><span className="bulk-status" id="reviewBatchStatus" role="status"></span></div>
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
              <div className="ingest-copy"><h2>加入收藏</h2><p>原文件按 SHA-256 去重并保存到共享 R2。每个收藏可补充作者、风格和标签，之后按分类快速筛选。</p><div className="ingest-actions"><button className="primary-button" id="chooseAssets">选择 SVG / HTML</button><button className="secondary-button" id="chooseAssetFolder">选择收藏文件夹</button><input id="assetInput" type="file" accept=".svg,.html,.htm,image/svg+xml,text/html" multiple hidden /><input id="assetFolderInput" type="file" accept=".svg,.html,.htm,image/svg+xml,text/html" webkitdirectory="" multiple hidden /></div><p className="ingest-note">SVG 使用安全图片预览；HTML 使用无权限 sandbox 预览，不会在收藏库页面执行脚本。</p></div>
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
              <div className="density-toggle" id="themeDensity" role="group" aria-label="主题排列方式"><button type="button" className="density-option is-active" data-density="grid" aria-pressed="true">网格</button><button type="button" className="density-option" data-density="list" aria-pressed="false">列表</button></div>
            </LibraryTools>
            <p className="cache-info" data-cache-info></p>
            <p className="catalog-status" data-library-status="theme" role="status">正在读取主题…</p>
            <div className="bulk-toolbar catalog-bulk" id="themeToolbar" hidden><Button id="toggleThemeSelection" variant="outline" aria-pressed="false">多选</Button><label className="select-label"><input type="checkbox" id="selectAllThemes" />全选结果</label><span className="selection-count" id="themeSelectedCount">已选 0 项</span><label className="select-label bundle-toggle"><input type="checkbox" data-bundle="theme" defaultChecked />打包成 ZIP</label><button className="secondary-button" id="syncSelectedThemes" type="button" disabled>后台同步所选</button><button className="secondary-button" id="downloadSelectedTheme" type="button" disabled>下载所选</button><button className="secondary-button" id="bulkCategoryTheme" type="button" disabled>修改类别</button><button className="danger-button" id="deleteSelectedTheme" type="button" disabled>删除所选</button><Button variant="outline" data-bulk-tags="theme">批量标签</Button><Button variant="ghost" data-clear-selection="theme" hidden>清空已选</Button><span id="themeSelectionHint" role="status" hidden>点击卡片任意位置选择，点右上角查看详情。</span><span className="bulk-status" id="themeBatchStatus" role="status"></span></div>
            <div id="themeList" className="theme-list"></div>
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
            <LibrarySearch id="fontSearchInput" label="搜索字体" placeholder="搜索字体名称或文件名" />
            <LibraryTools kind="font" refreshId="refreshFonts"><div className="font-filters" id="fontCategoryFilters" role="group" aria-label="字体分类"></div></LibraryTools>
            <p className="cache-info" data-cache-info></p>
            <p className="catalog-status" data-library-status="font" role="status">正在读取字体…</p>
            <div className="bulk-toolbar catalog-bulk" id="fontToolbar" hidden><label className="select-label"><input type="checkbox" id="selectAllFonts" />全选结果</label><span className="selection-count" id="fontSelectedCount">已选 0 项</span><label className="select-label bundle-toggle"><input type="checkbox" data-bundle="font" defaultChecked />打包成 ZIP</label><button className="secondary-button" id="syncSelectedFonts" type="button" disabled>后台同步所选</button><button className="secondary-button" id="downloadSelectedFont" type="button" disabled>下载所选</button><button className="danger-button" id="deleteSelectedFont" type="button" disabled>删除所选</button><Button variant="outline" data-bulk-tags="font">批量标签</Button><Button variant="ghost" data-clear-selection="font" hidden>清空已选</Button><span className="bulk-status" id="fontBatchStatus" role="status"></span></div><div id="fontList" className="font-list"></div><LibraryPager kind="font" /><div className="empty-state" id="fontEmpty" hidden><h3>还没有字体</h3><p>从单个文件或文件夹开始建立字体索引。</p><Button variant="outline" data-library-empty="font">导入文件</Button></div>
          </section>
        </section>

        <section className="view" id="assetsView" data-view-panel="assets" hidden>
          <div className="title-row catalog-title"><div><h1 tabIndex={-1}>收藏库</h1><p className="lede">浏览已收藏的 SVG 和 HTML 文件。</p></div><div className="title-meta"><span id="assetCount" aria-live="polite">正在读取…</span></div></div>
          <section className="asset-area">
            <LibrarySearch id="assetSearchInput" label="搜索收藏" placeholder="搜索名称、作者或标签" />
            <LibraryTools kind="asset" refreshId="refreshAssets">
              <div className="asset-filters" role="group" aria-label="收藏分类筛选"><button className="filter-chip is-active" type="button" data-asset-filter="all">全部</button><button className="filter-chip" type="button" data-asset-filter="ungrouped">未分组</button><button className="filter-chip" type="button" data-asset-filter="author">按作者</button><button className="filter-chip" type="button" data-asset-filter="style">按风格</button></div>
              <Button variant="outline" id="addAssetButton">添加收藏</Button>
            </LibraryTools>
            <p className="cache-info" data-cache-info></p>
            <p className="catalog-status" data-library-status="asset" role="status">正在读取收藏…</p>
            <div className="bulk-toolbar catalog-bulk" id="assetToolbar" hidden><label className="select-label"><input type="checkbox" id="selectAllAssets" />全选结果</label><span className="selection-count" id="assetSelectedCount">已选 0 项</span><label className="select-label bundle-toggle"><input type="checkbox" data-bundle="asset" defaultChecked />打包成 ZIP</label><button className="secondary-button" id="downloadSelectedAsset" type="button" disabled>下载所选</button><Button variant="outline" data-bulk-tags="asset">批量标签</Button><Button variant="ghost" data-clear-selection="asset" hidden>清空已选</Button><button className="danger-button" id="deleteSelectedAsset" type="button" disabled>删除所选</button><span className="bulk-status" id="assetBatchStatus" role="status"></span></div>
            <div id="assetList" className="asset-list asset-library-list"></div>
            <LibraryPager kind="asset" />
            <div className="empty-state" id="assetEmpty" hidden><h3>还没有收藏</h3><p>导入 SVG 或 HTML 文件开始。</p><Button variant="outline" data-library-empty="asset">导入文件</Button></div>
          </section>
        </section>


        <section className="view" id="jobsView" data-view-panel="jobs" hidden>
          <div className="title-row"><div><h1>上传与恢复</h1><p className="lede">普通上传的未完成文件保存在本设备；云端暂存文件可跨设备继续。每个文件成功后记录进度，关闭网页会暂停当前设备的处理。</p></div><button className="text-button" id="refreshJobs">刷新任务</button></div>
          <div className="form-actions"><button className="secondary-button" id="resumeStagedJobs" type="button">继续处理暂存文件</button><button className="text-button" id="clearFinishedJobs" type="button">清除已完成任务</button><label className="check-label queue-later-label"><input id="autoResumeQueue" type="checkbox" /><span>打开页面时自动继续云端排队的批次</span></label></div>
          <p className="operation-status" id="jobsStatus" role="status"></p><div id="jobList" className="job-list"></div><div className="empty-state" id="jobsEmpty"><h2>暂时没有后台任务</h2><p>确认主题或同步资产后，这里会显示进度和结果。</p></div>
        </section>

        <section className="view" id="storageView" data-view-panel="storage" hidden>
          <div className="title-row"><div><h1>存储设置</h1><p className="lede">压缩 RED、预览图和字体存入 R2；原始 RED 可另存到 123 云盘。</p></div><div className="title-meta"><span id="storageState">正在读取配置</span></div></div>
          <section className="settings-grid">
            <div className="settings-label"><h2>多设备访问</h2><p>GitHub Pages 等静态站点可以把界面连接到单独的同步 API。API 地址只保存在当前浏览器，不在仓库中保存密钥。</p></div>
            <div className="settings-panel static-api-panel"><label>同步 API 地址<input id="apiBaseInput" type="url" inputMode="url" placeholder="https://red-garden-sync.pages.dev" autoComplete="off" spellCheck="false" /></label><label>私有库访问口令<input id="syncTokenInput" type="password" inputMode="text" placeholder="新设备请导入配置或填写口令" autoComplete="off" spellCheck="false" /></label><p className="field-help">Pages 版本连接私有共享库；填写相同同步地址的设备读取同一个 R2 库。此站无需在每台电脑填写 R2 Access Key。写入 Token 在当前浏览器自动保存；换设备可使用下方加密配置迁移。</p><div className="form-actions"><button className="secondary-button" id="saveApiBase" type="button">保存并连接</button><button className="secondary-button" id="testWriteAccess" type="button">检测写入权限</button><button className="text-button" id="clearApiBase" type="button">恢复默认连接</button></div><p className="operation-status" id="apiBaseStatus" role="status"></p></div>
            <div className="settings-label"><h2>换设备，一次导入</h2><p>网页地址相同，浏览器里的凭据仍然各自独立。用加密文件迁移同步 Token 和可选的 123 会话，无需重复配置 R2。</p></div>
            <form className="settings-panel" id="deviceTransferForm">
              <label>迁移口令<input type="password" name="passphrase" minLength={8} autoComplete="new-password" placeholder="至少 8 位；导入时使用相同口令" required /></label>
              <label className="check-label"><input type="checkbox" name="include123" /><span>导出时同时包含 123 登录会话（可选）</span></label>
              <label>导入已加密的配置<input type="file" name="configFile" accept=".json" /></label>
              <div className="form-actions"><Button type="submit" name="action" value="export" variant="outline">导出加密配置</Button><Button type="submit" name="action" value="import">导入并连接</Button><Button type="submit" value="cloud-save" variant="outline">保存云端密文</Button><Button type="submit" value="cloud-load" variant="outline">恢复云端配置</Button><Button type="submit" value="link" variant="ghost">生成设备接入链接</Button></div>
              <label id="deviceLinkLabel" hidden>设备接入链接<Input id="deviceConnectLink" readOnly onFocus={event=>event.target.select()} /></label>
              <p className="field-help">配置在本机用 AES-GCM 加密，文件、接入链接和云端只保存密文。请把迁移口令与接入链接分开传送。每个浏览器导入一次；123 仍可能因到期或平台风控要求重新登录。</p>
              <p className="operation-status" id="deviceTransferStatus" role="status"></p>
            </form>
            <div className="settings-label"><h2>原始 RED 备份到 123 云盘</h2><p>可用账号密码或网页登录，将未压缩的 RED 原包额外备份到 123 云盘。登录会话保存在当前设备。</p></div>
            <div className="settings-panel">
              <form className="pan123-quick-login" id="pan123QuickLogin" autoComplete="off">
                <div className="field-pair">
                  <label>123 云盘账号<input name="username" autoComplete="username" autoCapitalize="none" spellCheck="false" placeholder="手机号或邮箱" required /></label>
                  <label>登录密码<input name="password" type="password" autoComplete="current-password" spellCheck="false" required /></label>
                </div>
                <div className="form-actions">
                  <button className="primary-button" type="submit" id="pan123QuickLoginButton">登录并连接</button>
                  <button className="text-button" id="pan123WebLogin" type="button">改用网页登录</button>
                </div>
                <p className="field-help" id="pan123WebLoginHint">连接共享库时，浏览器直接登录 123 云盘。</p>
              </form>
              <label>备份目录<input id="pan123BackupFolder" type="text" spellCheck="false" defaultValue="Red-Garden-Backup" /></label>
              <div className="form-actions">
                <button className="secondary-button" id="savePan123Backup" type="button">保存备份设置</button>
                <button className="secondary-button" id="verifyPan123Backup" type="button">测试连接</button>
                <button className="secondary-button" id="listPan123Backup" type="button">查看备份清单</button>
                <button className="secondary-button" id="verifyPan123Write" type="button">验证备份写入</button>
                <button className="text-button" id="clearPan123Backup" type="button">关闭备份</button>
              </div>
              <p className="operation-status" id="pan123BackupStatus" role="status"></p>
              <div className="backup-inventory" id="pan123BackupList" aria-live="polite"></div>
              <details className="session-fallback" id="pan123TokenDetails"><summary>已有会话 Token？直接粘贴</summary><div className="session-fallback-content"><label>123 云盘会话 Token<input id="pan123BackupToken" type="password" autoComplete="off" spellCheck="false" placeholder="登录成功后自动填入，也可粘贴会话 Token" /></label><button className="secondary-button" id="pan123PasteToken" type="button">从剪贴板粘贴</button><p className="field-help" id="pan123PasteHint">在 123 网盘登录页复制过 Authorization 的 Bearer 值后，点这里直接填入并验证。</p></div></details>
              <p className="field-help">需要先填写上方同步 API 地址与写入 Token。备份由同一个 Worker 代转，Token 不会写入仓库或 R2；留空时只保留 R2 原包。「测试连接」和「查看备份清单」只读，不创建任何文件或文件夹。「验证备份写入」会在备份目录下新建 <code>_verify/</code> 子目录并上传 1 个约 40 字节的 <code>reeden-backup-check.red</code> 测试文件（会保留在云盘），用来确认写入链路真的可用。</p>
            </div>
            <div className="settings-label"><h2>已有资产与存储地</h2><p>本地文件和已读取的云端清单分别计数。读取 R2 已有库后，新导入主题会与云端记录一起检查重复。</p><p className="settings-note" id="storageDestination">尚未连接云端存储。</p></div>
            <div className="settings-panel"><div id="storageInventory" className="storage-inventory" aria-live="polite">正在读取本地资产…</div></div>
            <div className="settings-label" id="r2SettingsLabel"><h2>Cloudflare R2</h2><p>一个私有 Bucket 存放主题文件、预览图、字体和库清单；普通主题可在设备本地压缩，加密主题会先在设备压缩明文图片，再由同步 Worker 认证重封。预览优先组合日间书架，有同模式启动图时一起展示，日间无可用资源才读取夜间。文件使用临时下载地址，Bucket 无需公开。</p><p className="settings-note" id="credentialState">尚未配置 R2 凭据。</p><p className="settings-note"><a className="download-link" href="https://dash.cloudflare.com/?to=/:account/r2/overview" target="_blank" rel="noreferrer">打开 Cloudflare R2 控制台</a></p><p className="settings-note"><a className="download-link" href="https://developers.cloudflare.com/r2/api/tokens/" target="_blank" rel="noreferrer">查看 R2 访问密钥说明</a></p></div>
            <form className="settings-panel" id="storageForm" autoComplete="off">
              <p className="operation-status" id="storageBusyNote" hidden>后台任务正在使用当前存储位置，完成后可修改配置。</p>
              <label>资产存储<select name="libraryProvider"><option value="local">仅本地文件夹</option><option value="cloudflare_r2">Cloudflare R2（S3 兼容）</option></select></label>
              <div id="r2Fields" className="storage-fields">
                <div className="field-pair"><div className="field-group"><label>Cloudflare Account ID<input name="accountId" placeholder="32 位 Account ID" aria-describedby="accountIdHelp" spellCheck="false" /></label><p className="field-help" id="accountIdHelp">在 Cloudflare 控制台按 Ctrl + K，搜索 Copy account ID 并复制。<a className="download-link" href="https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/" target="_blank" rel="noreferrer">查看查找位置</a></p></div><div className="field-group"><label>Bucket 名称<input name="bucket" placeholder="你的 R2 Bucket 名称" aria-describedby="bucketHelp" spellCheck="false" /></label><p className="field-help" id="bucketHelp">R2 控制台 → Overview，复制已有存储桶的名称。</p></div></div>
                <label>S3 Endpoint（可选）<input name="endpoint" type="url" placeholder="https://<ACCOUNT_ID>.r2.cloudflarestorage.com" aria-describedby="endpointHelp" spellCheck="false" /></label><p className="field-help" id="endpointHelp">普通 Bucket 留空即可，由 Account ID 自动生成。也可从 R2 Overview 或创建密钥完成页底部复制 S3 API 地址；特殊区域使用控制台给出的地址。</p>
                <label>库目录前缀<input name="rootPath" placeholder="reeden-library" aria-describedby="rootPathHelp" spellCheck="false" /></label><p className="field-help" id="rootPathHelp">由你指定的库文件夹，默认 reeden-library。读取已有文件时填它们所在目录；若文件在 Bucket 根目录，留空。</p>
                <div className="field-pair"><label>Access Key ID<input name="accessKeyId" type="password" autoComplete="off" spellCheck="false" aria-describedby="r2KeyHelp" /></label><label>Secret Access Key<input name="secretAccessKey" type="password" autoComplete="off" spellCheck="false" aria-describedby="r2KeyHelp" /></label></div>
                <p className="field-help" id="r2KeyHelp">R2 Overview → API Tokens 旁的 Manage → 创建 Account 或 User API token。权限选 Object Read &amp; Write，仅授权此 Bucket；创建完成后分别复制 Access Key ID 和 Secret Access Key。Secret 只显示一次，丢失需创建新密钥。这里填写 R2 的 S3 密钥对，不填普通 Cloudflare API Token。密钥仅提交到本机后端，并由 Windows 当前用户加密保存；已有凭据时留空可保留。</p>
                <label className="check-label"><input name="autoSync" type="checkbox" /><span>主题确认或字体导入后，自动同步到 R2</span></label>
              </div>
              <div className="archive-fields">
                <h3>原始 RED 备份</h3>
                <label>原始包存储<select name="archiveProvider"><option value="local">本地单独保存</option><option value="r2_library">R2 原包目录（复用上方连接）</option><option value="123pan">123 云盘（网页协议）</option><option value="123pan_webdav">旧配置：123 WebDAV（需自行提供服务）</option></select></label>
                <label>备份目录<input name="archiveRootPath" placeholder="originals" spellCheck="false" aria-describedby="archiveHint" /></label>
                <label id="archiveEndpointField" hidden>旧 WebDAV 服务地址<input name="archiveEndpoint" type="url" placeholder="https://你的-webdav-endpoint/" spellCheck="false" /></label>
                <p className="field-help" id="archiveHint">原始 RED 保留在本机，切换到 R2 原包目录可直接上传云端。</p>
                <label className="check-label"><input name="cloudOnly" type="checkbox" aria-describedby="cloudOnlyHelp" /><span>上传核验后，清理本机处理副本</span></label>
                <p className="field-help" id="cloudOnlyHelp">需启用 R2 资产存储，并将原包备份到 R2 或 123 云盘。文件上传、回读 SHA-256 核验及清单保存成功后，才清理应用内的原包、压缩包、预览和字体副本；失败会保留。你选择文件前所在的原始文件夹不会被删除。本机仍保留库索引。</p>
              </div>
              <div className="form-actions"><button className="primary-button" type="submit">保存配置</button><button className="secondary-button" id="testStorage" type="button">测试 R2 连接</button><button className="text-button" id="testArchive" type="button">测试归档连接</button></div>
              <p className="operation-status" id="configStatus" role="status">保存后请测试连接。</p>
            </form>
            <div className="settings-label" id="pan123Label" hidden><h2>连接 123 云盘</h2><p>123 云盘只备份原始 RED，压缩 RED、字体和预览仍使用上方的 R2。扫码确认后，登录会话由当前 Windows 用户加密保存。</p><p className="settings-note" id="pan123CredentialState">尚未保存 123 云盘会话。</p><p className="settings-note"><a className="download-link" href="https://www.123pan.com/" target="_blank" rel="noreferrer">打开 123 云盘</a></p></div>
            <div className="settings-panel" id="pan123Panel" hidden>
              <div className="qr-login"><h3>扫码登录</h3><p className="field-help">用123云盘App或微信扫码并确认。二维码按需生成，2 分钟内有效。</p><div className="form-actions"><button className="secondary-button" id="startPan123Qr" type="button">扫码连接</button></div><div className="qr-login-code" id="pan123QrCode" hidden><div className="qr-host" id="pan123QrHost"></div><button className="text-button" id="stopPan123Qr" type="button">取消扫码</button></div><p className="operation-status" id="pan123QrStatus" role="status"></p></div>
              <details className="session-fallback" id="pan123PasswordDetails"><summary>使用账号密码登录</summary><div className="session-fallback-content"><form id="pan123LoginForm" className="credential-form" autoComplete="off">
                <div className="field-pair"><label>123 云盘账号<input name="username" autoComplete="off" autoCapitalize="none" spellCheck="false" required aria-describedby="pan123LoginHelp" /></label><label>登录密码<input name="password" type="password" autoComplete="new-password" spellCheck="false" required aria-describedby="pan123LoginHelp" /></label></div>
                <p className="field-help" id="pan123LoginHelp">仅提交给同步 Worker，密码用完即丢弃。账号与密码不会随“保存配置”提交；点击登录后会清空输入。</p>
                <div className="form-actions"><button className="secondary-button" type="submit">登录并保存会话</button></div>
              </form></div></details>
              <details className="session-fallback" id="pan123SessionDetails"><summary>登录需要验证码？使用已有会话</summary><div className="session-fallback-content"><p className="field-help">在你自己的浏览器打开 123 云盘并登录。按 F12 → Network（网络），刷新文件列表，在发往 123 云盘的请求中查找 Authorization 请求头，只复制 Bearer 后的会话 Token。不要粘贴 Cookie 或完整请求。会话等同登录凭据，仅在此处提交给本机服务。</p><form id="pan123SessionForm" className="credential-form" autoComplete="off"><label>会话 Token<input name="token" type="password" autoComplete="new-password" spellCheck="false" required aria-describedby="pan123TokenHelp" /></label><p className="field-help" id="pan123TokenHelp">使用当前 Windows 用户加密保存。提交后清空输入，不会显示已保存的 Token。</p><div className="form-actions"><button className="secondary-button" type="submit">保存会话</button></div></form></div></details>
              <div className="form-actions"><Button id="copyPan123Diagnostics" type="button" variant="outline">复制 123 诊断</Button><a className="download-link" href="https://www.123pan.com/" target="_blank" rel="noreferrer">前往官方网页完成验证</a></div><pre id="pan123Diagnostics" className="diagnostic-output" hidden></pre><p className="field-help">尚未开通开放平台时继续使用现有会话。遇到验证码请先在官方网页完成；云端无法代替本人验证。</p><p className="operation-status" id="pan123Status" role="status">先保存原始包存储和目录，再验证上传与回读。</p>
              <div className="archive-probe" id="pan123ProbeBlock"><p className="field-help" id="pan123ProbeHelp">验证会在备份目录的 probes/ 下上传一个随机小文件，再下载并核验。测试目录和文件可能保留在云盘。</p><div className="form-actions"><button className="secondary-button" id="probePan123" type="button" aria-describedby="pan123ProbeHelp">上传测试文件并回读</button><button className="text-button" type="button" data-open-view="jobs">查看上传与恢复</button></div></div>
              <p className="field-help">连接验证由同步 Worker 转发；文件压缩需要保持页面打开，中断后可从恢复入口继续。</p>
            </div>
            <div className="settings-label"><h2>历史文件清理</h2><p>先核对再删除。正在使用的文件和未满 7 天的文件会保留。</p></div><div className="settings-panel"><div className="form-actions"><Button id="maintenancePlan" type="button" variant="outline">生成核对清单</Button><Button id="maintenanceDelete" type="button" variant="destructive" hidden>删除清单中的旧文件</Button></div><p className="operation-status" id="maintenanceStatus" role="status"></p><pre id="maintenanceList" className="diagnostic-output"></pre></div><div className="settings-label"><h2>读取与同步</h2><p>读取已有库会合并主题名、作者、哈希和预览。没有库清单的已有文件会单独列出，不自动下载或覆盖。</p></div>
            <div className="settings-panel"><div className="form-actions"><button className="secondary-button" id="pullStorage" type="button">读取 R2 已有库</button><button className="secondary-button" id="syncStorage" type="button">同步本地资产到 R2</button></div><p className="operation-status" id="storageOperation" role="status">尚未读取 R2 已有库。</p><div id="storageUnindexed" hidden></div></div>
          </section>
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
      <button type="button" data-more-view="storage">存储设置</button>
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
    <dialog className="preview-dialog cleanup-dialog" id="cleanupDialog" aria-labelledby="cleanupDialogTitle" aria-describedby="cleanupDialogDescription"><div className="preview-dialog-head"><div><h2 id="cleanupDialogTitle">删除本地文件</h2><p className="preview-description" id="cleanupDialogDescription"></p></div><button className="icon-button" id="closeCleanupDialog" type="button" aria-label="关闭">×</button></div><div className="cleanup-toolbar"><label className="check-label"><input id="cleanupSelectAll" type="checkbox" defaultChecked /><span id="cleanupSelectAllLabel">全选</span></label><span id="cleanupSummary"></span><Button id="cleanupGrantFolder" variant="outline" type="button">授权所在文件夹</Button></div><ul className="cleanup-list" id="cleanupList"></ul><p className="cleanup-note" id="cleanupNote">删除只作用于本机文件，云端库和 R2 里的记录不受影响；之后仍可从云端重新下载。</p><div className="modal-actions"><button className="secondary-button" id="cleanupCancel" type="button">保留文件</button><button className="primary-button" id="cleanupConfirm" type="button">删除所选</button></div></dialog>
    <div className="modal-backdrop" id="modalBackdrop" hidden><section className="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle"><div className="modal-head"><div><h2 id="modalTitle">确认主题</h2><p id="modalSubtitle">查看候选后再保存。</p></div><button className="icon-button" id="closeModal" aria-label="关闭">×</button></div><div id="modalBody"></div></section></div>
  </>;
}
