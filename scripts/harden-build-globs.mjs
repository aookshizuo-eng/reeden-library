import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const file=require.resolve('picomatch/lib/parse.js');
const marker='/* Reeden: disable repeated extglobs until GHSA-fc5q-39xc-vjpf is patched upstream. */';
let source=await readFile(file,'utf8');
if(!source.includes(marker)){
 const needle='const analyzeRepeatedExtglob = (body, options) => {';
 if(!source.includes(needle))throw new Error('picomatch parser changed; review the build-only extglob mitigation before installing');
 source=source.replace(needle,needle+'\n  '+marker+'\n  return { risky: true };');
 await writeFile(file,source);
}
console.log('Build glob mitigation active: repeated extglobs are treated as literals.');
