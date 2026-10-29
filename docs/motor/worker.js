// Corre el motor en segundo plano (Web Worker) para que la página no se congele.
// Mensajes: { id, tipo: "especies" | "inventario" | "planificar", datos } -> { id, ok, resultado | error, usuario }
import { Dex } from "./dex.js";
import { ErrorUsuario, especiesCriables, inventario, planificar } from "./servicio.js";

const dex = fetch(new URL("../data/pokedex.json", import.meta.url))
  .then(r => r.json())
  .then(d => new Dex(d));

self.onmessage = async ({ data: { id, tipo, datos } }) => {
  try {
    const d = await dex;
    let resultado;
    if (tipo === "especies") resultado = especiesCriables(d);
    else if (tipo === "inventario") resultado = inventario(d, datos.texto ?? "");
    else if (tipo === "planificar") resultado = planificar(d, datos);
    else throw new Error(`pedido desconocido: ${tipo}`);
    self.postMessage({ id, ok: true, resultado });
  } catch (e) {
    const usuario = e instanceof ErrorUsuario;
    self.postMessage({ id, ok: false, usuario, error: usuario ? e.message : `Error interno: ${e.message}` });
  }
};
