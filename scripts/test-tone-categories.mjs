// 颜色自动分类的纯函数回归：低饱和/高饱和、白/黑/明亮/暗色要能分清，
// 阈值统一、互不抢。直接从 app.js 抽出这几个纯函数在 Node 里求值。
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
const root=fileURLToPath(new URL('..',import.meta.url));
const app=await readFile(new URL('../site/app.js',import.meta.url),'utf8');
// 截取从 DEFAULT_THEME_CATEGORIES 到 themeCategoryList 之前的纯函数区。
const start=app.indexOf('const DEFAULT_THEME_CATEGORIES');
const end=app.indexOf('function themeCategoryList(');
assert.ok(start>0&&end>start,'没找到色调分类函数区');
const slice=app.slice(start,end);
const context={};
vm.createContext(context);
vm.runInContext(slice+'\nglobalThis.__api={TONE,hueColorFamily,toneFamilies,themeToneCategory,themeToneCategories};',context);
const {TONE,hueColorFamily,toneFamilies,themeToneCategory,themeToneCategories}=context.__api;

const families=(light,saturation,extra={})=>
  toneFamilies({light,saturation,hueStrength:saturation>.25?1.4:0,colorFamily:hueColorFamily(200,saturation,light),warm:false,...extra});

// 明度极端值：白、黑、暗、明亮要各自分辨，不被色相带跑。
assert.ok(families(.93,.05).includes('白色系'),'接近白应打白色系');
assert.ok(families(.05,.05).includes('黑色系'),'接近黑应打黑色系');
assert.ok(families(.2,.4).includes('暗色'),'暗但有色相应打暗色');
assert.ok(families(.82,.1).includes('明亮'),'亮但不过白应打明亮');
// 饱和度档：低饱和 / 高饱和都要显式出现，不能都归成暖色/冷色。
assert.ok(families(.5,.10).includes('低饱和'),'低饱和要明确打出来');
assert.ok(families(.5,.80).includes('高饱和'),'高饱和要明确打出来');
assert.ok(!families(.5,.40).includes('低饱和')&&!families(.5,.40).includes('高饱和'),'中等饱和不该打低/高饱和');
// 灰色系：饱和度极低时按灰处理，而不是硬贴颜色。
assert.ok(families(.5,.05).includes('灰色系'),'无饱和度应打灰色系');
// 色系：饱和度够、色相集中才认，且白色主题不重复贴色系。
assert.ok(families(.5,.7,{colorFamily:'蓝色系'}).includes('蓝色系'),'明确色相应打色系');
assert.ok(!families(.93,.3,{colorFamily:'蓝色系'}).includes('蓝色系'),'白色主题不该再贴色系');
// 冷暖兜底：没有其它标签时至少给一个冷暖。
assert.equal(JSON.stringify(toneFamilies({light:.5,saturation:.3,hueStrength:0,warm:true})),'["暖色"]');
// 主分类与全部分类一致，且档位齐全。
assert.equal(themeToneCategory({light:.2,saturation:.7,colorFamily:'蓝色系',hueStrength:1.4}),'暗色');
assert.ok(themeToneCategories({light:.2,saturation:.7,colorFamily:'蓝色系',hueStrength:1.4}).includes('暗色'));
assert.ok(themeToneCategories({light:.2,saturation:.7,colorFamily:'蓝色系',hueStrength:1.4}).includes('高饱和'));
// 阈值常量本身要有序，方便以后调。
assert.ok(TONE.black<TONE.dark&&TONE.dark<TONE.bright&&TONE.bright<TONE.white,'明度阈值顺序');
assert.ok(TONE.gray<TONE.lowSat&&TONE.lowSat<TONE.hueMin&&TONE.hueMin<TONE.highSat,'饱和度阈值顺序');
console.log('PASS: 色调分类阈值统一，白/黑/明亮/暗色、低饱和/高饱和、色系/冷暖都能正确区分。');
