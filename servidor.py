"""Servidor local de PokeCrianza: solo sirve la página de docs/ (el cálculo corre en el navegador).

Uso:  python servidor.py     (abre el navegador solo; --no-abrir para que no)

Es lo mismo que se publica en GitHub Pages; esto es para usarlo sin internet.
"""
from __future__ import annotations

import sys
import threading
import time
import urllib.request
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DOCS = Path(__file__).resolve().parent / "docs"
PUERTO = 8765  # siempre el mismo: los árboles guardados en el navegador dependen de la dirección


class Handler(SimpleHTTPRequestHandler):
    # Windows a veces registra .js como texto plano y el navegador no lo carga como módulo.
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".json": "application/json"}

    def log_message(self, fmt, *args):  # silenciar el log por pedido
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")  # siempre la versión actual de los archivos
        super().end_headers()

    def do_POST(self):
        # Otra copia de PokeCrianza que arranca pide el puerto: se cierra esta (la vieja).
        # El encabezado propio evita que cualquier página web pueda pedirlo.
        if self.path == "/api/apagar" and self.headers.get("X-PokeCrianza") == "apagar":
            self.send_response(200)
            self.end_headers()
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        self.send_error(404)


class Servidor(ThreadingHTTPServer):
    # En Windows, reuse_address deja a dos procesos escuchar el mismo puerto.
    allow_reuse_address = False


def _nuevo() -> Servidor:
    return Servidor(("127.0.0.1", PUERTO), partial(Handler, directory=str(DOCS)))


def _apagar_anterior() -> Servidor | None:
    """Si hay un PokeCrianza viejo en el puerto, lo cierra y toma su lugar."""
    try:
        pedido = urllib.request.Request(f"http://127.0.0.1:{PUERTO}/api/apagar", data=b"{}",
                                        headers={"X-PokeCrianza": "apagar"})
        urllib.request.urlopen(pedido, timeout=2).read()
    except Exception:  # noqa: BLE001 - no era PokeCrianza (o es una versión sin /api/apagar)
        return None
    for _ in range(30):
        try:
            return _nuevo()
        except OSError:
            time.sleep(0.1)
    return None


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        server = _nuevo()
    except OSError:
        server = _apagar_anterior()
        if server is None:
            raise SystemExit(f"El puerto {PUERTO} está ocupado por otro programa. Cerralo y volvé a intentar.")
        print("Había otro PokeCrianza abierto: lo cerré y abrí la versión actual.")
    url = f"http://127.0.0.1:{PUERTO}/"
    print(f"PokeCrianza abierto en {url}  (Ctrl+C para cerrar)")
    if "--no-abrir" not in sys.argv:
        threading.Timer(0.5, webbrowser.open, [url]).start()
    try:
        server.serve_forever()
        print("Se abrió otra ventana de PokeCrianza y esta quedó cerrada: podés cerrar esta ventana.")
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
