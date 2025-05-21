const express = require('express');
const fs = require('fs');
const https = require('https');
const path = require('path');

const app = express();

// static files
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: function(res, path){
        res.set('content-security-policy',"\
            default-src 'self';\
            child-src 'self' blob:; \
            worker-src 'self' blob:; \
            connect-src 'self' \
                        https://cdn.jsdelivr.net/npm/\
                        https://mlts.dynamsoft.com/\
                        https://slts.dynamsoft.com/\
                        https://mdls.dynamsoftonline.com/\
                        https://sdls.dynamsoftonline.com/; \
            script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net/npm/ blob:; \
            media-src 'self' data:;\
            img-src 'self' data: blob:;\
            style-src-attr 'self' 'unsafe-inline';\
            style-src 'self' 'unsafe-inline';\
        ")
    }
}));

let httpsServer = https.createServer({
    key: fs.readFileSync(path.join(__dirname, 'pem/ryans-key.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'pem/ryans-cert.pem'))
}, app);

let httpsPort = 4443;
httpsServer.listen(httpsPort, () => console.log('Page is available in https://localhost:'+httpsPort+'/'));
