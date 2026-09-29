// Local-only static preview. Run: node scripts/preview.cjs
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const types = {'.glb':'model/gltf-binary','.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'};
http.createServer((req,res) => {
    if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405);res.end();return; }
    let file;
    try { const pathname = new URL(req.url,'http://localhost').pathname; file = path.resolve(root,'.'+decodeURIComponent(pathname === '/' ? '/index.html' : pathname)); }
    catch { res.writeHead(400);res.end();return; }
    if (!file.startsWith(root+path.sep) || !types[path.extname(file).toLowerCase()]) { res.writeHead(403);res.end();return; }
    fs.readFile(file,(err,body) => { if(err){res.writeHead(404);res.end('Not found');return;}res.writeHead(200,{'Content-Type':types[path.extname(file).toLowerCase()],'Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:body); });
}).listen(4178,'127.0.0.1',()=>console.log('Preview: http://127.0.0.1:4178/index.html'));
