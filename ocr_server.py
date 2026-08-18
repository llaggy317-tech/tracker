# CII Vision Services - Local CAPTCHA OCR Solver
import sys
import json
import base64
import re
from http.server import HTTPServer, BaseHTTPRequestHandler
import ddddocr

PORT = 3002
ocr = None

class OCRHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # Suppress default noisy console logs

    def do_POST(self):
        if self.path == '/solve':
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            try:
                data = json.loads(body.decode('utf-8'))
                img_b64 = data.get('image', '')
                if 'base64,' in img_b64:
                    img_b64 = img_b64.split('base64,')[1]
                
                img_bytes = base64.b64decode(img_b64)
                raw = ocr.classification(img_bytes)
                clean = re.sub(r'[^a-zA-Z0-9]', '', raw)
                
                res = json.dumps({'success': True, 'text': clean}).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(res)
            except Exception as e:
                err = json.dumps({'success': False, 'error': str(e)}).encode('utf-8')
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(err)
        else:
            self.send_response(404)
            self.end_headers()

    def do_GET(self):
        if self.path == '/health':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')
        else:
            self.send_response(404)
            self.end_headers()

def run():
    global ocr
    print("[OCR] Initializing ddddocr model...", flush=True)
    ocr = ddddocr.DdddOcr(show_ad=False)
    server = HTTPServer(('127.0.0.1', PORT), OCRHandler)
    print(f"[OCR] Local CAPTCHA Solver ready on http://127.0.0.1:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

if __name__ == '__main__':
    run()
