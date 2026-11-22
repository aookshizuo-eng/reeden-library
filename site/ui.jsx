import {cva} from "class-variance-authority";
import {clsx} from "clsx";
import {twMerge} from "tailwind-merge";
import {Search, X, RefreshCw} from "lucide-react";

const cn = (...classes) => twMerge(clsx(classes));
const buttonVariants = cva("inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md border border-transparent text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:pointer-events-none disabled:opacity-50", {
  variants: {
    variant: {
      default: "bg-[var(--text)] text-white hover:bg-[var(--accent-deep)]",
      destructive: "bg-[var(--danger)] text-white hover:opacity-90",
      outline: "border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--raised)]",
      ghost: "bg-transparent text-[var(--muted)] hover:bg-[var(--raised)]",
    },
    size: {default: "h-10 px-3", icon: "size-10"},
  },
  defaultVariants: {variant: "default", size: "default"},
});

export function Button({className, variant, size, type = "button", ...props}) {
  return <button type={type} data-slot="button" data-variant={variant || "default"} className={cn(buttonVariants({variant, size}), className)} {...props} />;
}

export function Input({className, ...props}) {
  return <input data-slot="input" className={cn("h-10 min-w-0 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 text-sm placeholder:text-[var(--faint)]", className)} {...props} />;
}

export function LibrarySearch({id, label, placeholder}) {
  return <div className="library-search relative min-w-0">
    <Search className="pointer-events-none absolute left-3 top-3 size-4 text-[var(--muted)]" aria-hidden="true" />
    <Input id={id} type="search" className="pl-9 pr-12" aria-label={label} placeholder={placeholder} autoComplete="off" />
    <kbd className="search-key pointer-events-none absolute right-3 top-2.5 rounded border border-[var(--border)] px-1.5 text-xs text-[var(--muted)]" aria-hidden="true">/</kbd>
    <Button className="absolute right-1 top-1 size-8" size="icon" variant="ghost" data-clear-search={id} aria-label="清空搜索" hidden><X size={16} aria-hidden="true" /></Button>
  </div>;
}

export function LibraryTools({kind, refreshId, children}) {
  return <div className="library-tools">
    {children}
    <label className="check-label recent-only"><input type="checkbox" data-recent-only={kind} />最近 24 小时入库</label>
    <select className="catalog-select" data-library-sort={kind} aria-label="排序方式" defaultValue="added">
      <option value="added">最新入库</option><option value="oldest">最早入库</option><option value="recent">最近修改</option><option value="name">按名称</option><option value="size">按大小</option>
    </select>
    <div className="density-toggle" id={`${kind}Density`} role="group" aria-label="排列方式"><button type="button" className="density-option is-active" data-catalog-density={kind} data-density="grid" aria-pressed="true">网格</button><button type="button" className="density-option" data-catalog-density={kind} data-density="list" aria-pressed="false">列表</button></div>
    <Button id={`toggle${kind[0].toUpperCase()+kind.slice(1)}Selection`} data-catalog-selection={kind} variant="outline" aria-pressed="false">多选</Button>
    <Button id={refreshId} variant="outline" size="icon" aria-label="刷新资源库" title="刷新资源库"><RefreshCw size={16} aria-hidden="true" /></Button>
  </div>;
}

export function LibraryPager({kind}) {
  return <nav className="pagination" id={`${kind}Pagination`} aria-label="资源库翻页" hidden>
    <Button variant="outline" id={`${kind}PrevPage`}>上一页</Button>
    <span id={`${kind}PageInfo`} aria-live="polite"></span>
    <Button variant="outline" id={`${kind}NextPage`}>下一页</Button>
    <form className="page-jump" data-page-jump={kind} noValidate><label htmlFor={`${kind}PageInput`}>跳至</label><Input id={`${kind}PageInput`} type="number" min="1" step="1" inputMode="numeric" aria-label="跳转页码" required /><span>页</span><Button variant="outline" type="submit">跳转</Button></form>
  </nav>;
}

export function LibraryBulk({kind}) {
  const capital=kind[0].toUpperCase()+kind.slice(1),plural=kind==='asset'?'Assets':capital+'s';
  return <div className="bulk-toolbar catalog-bulk" id={`${kind}Toolbar`} hidden>
    <label className="select-label"><input type="checkbox" id={`selectAll${plural}`} />全选结果</label><span className="selection-count" id={`${kind}SelectedCount`}>已选 0 项</span>
    <label className="select-label bundle-toggle"><input type="checkbox" data-bundle={kind} defaultChecked />打包成 ZIP</label>
    {kind==='theme'&&<label className="select-label"><input type="checkbox" data-download-extras="theme" />附带原包与预览</label>}
    <Button variant="outline" id={`downloadSelected${capital}`} disabled>下载所选</Button><Button variant="outline" id={`syncSelected${plural}`} disabled>同步所选</Button>
    {kind==='theme'&&<Button variant="outline" id="bulkCategoryTheme" disabled>修改类别</Button>}
    {kind==='theme'&&<Button variant="outline" id="bulkAuthorTheme" disabled>修改作者</Button>}
    <Button variant="outline" data-bulk-tags={kind}>批量标签</Button><Button variant="destructive" id={`deleteSelected${capital}`} disabled>删除所选</Button><Button variant="ghost" data-clear-selection={kind} hidden>清空已选</Button>
    <span className="catalog-selection-hint" id={`${kind}SelectionHint`} role="status" hidden>点击卡片选择，点右上角查看详情。</span><span className="bulk-status" id={`${kind}BatchStatus`} role="status"></span>
  </div>;
}
