// Lado de la página: habla con el motor que corre en Web Workers.
//
// - Un worker fijo para lo rápido (lista de especies, leer el PC).
// - Cada cálculo de árbol usa sus propios workers, que se cierran al terminar:
//   así varias pestañas pueden calcular a la vez sin esperarse.
// - Con una prioridad distinta de "cuidar Pokémon", se busca EN PARALELO también
//   cuidando Pokémon (la búsqueda puede meterse por otro lado y no ver rutas que
//   así sí aparecen) y gana la mejor según la prioridad elegida.

const URL_WORKER = new URL("./worker.js", import.meta.url);

export class ErrorMotor extends Error {
  constructor(msg, usuario) {
    super(msg);
    this.usuario = usuario;  // true: mensaje para mostrar tal cual (no es un error del programa)
  }
}

let siguiente = 1;
function pedir(worker, tipo, datos) {
  const id = siguiente++;
  return new Promise((ok, mal) => {
    const soltar = () => {
      worker.removeEventListener("message", escuchar);
      worker.removeEventListener("error", fallo);
    };
    const escuchar = ({ data }) => {
      if (data.id !== id) return;
      soltar();
      data.ok ? ok(data.resultado) : mal(new ErrorMotor(data.error, data.usuario));
    };
    const fallo = e => {
      soltar();
      mal(new ErrorMotor(`Error interno: ${e.message ?? "no se pudo cargar el motor"}`, false));
    };
    worker.addEventListener("message", escuchar);
    worker.addEventListener("error", fallo);
    worker.postMessage({ id, tipo, datos });
  });
}

let fijo;
const workerFijo = () => (fijo ??= new Worker(URL_WORKER, { type: "module" }));

export const especies = () => pedir(workerFijo(), "especies", {});
export const inventario = texto => pedir(workerFijo(), "inventario", { texto });

/** Corre un cálculo en un worker propio, que se cierra al terminar. */
function calcular(datos) {
  const w = new Worker(URL_WORKER, { type: "module" });
  const p = pedir(w, "planificar", datos);
  return { promesa: p.finally(() => w.terminate()), cancelar: () => w.terminate() };
}

/** Arma el árbol más barato según el pedido de la página. */
export async function planificar(pedido) {
  const peso = pedido.pesoCruce || 1;
  if (peso === 1) return calcular(pedido).promesa;

  const principal = calcular(pedido);
  const alternativa = calcular({ ...pedido, pesoCruce: 1, pesoEval: peso });
  const a = await principal.promesa.catch(e => { alternativa.cancelar(); throw e; });
  // Si la principal demuestra que es la más barata, o que no existe ninguna ruta
  // (no que se le acabó el tiempo), la otra sobra.
  const sobra = a.plan ? a.plan.optimo : !a.intentos?.some(t => t.estado === "limite");
  if (sobra) {
    alternativa.cancelar();
    return a;
  }
  const b = await alternativa.promesa.catch(() => null);
  if (!b?.plan) return a;
  if (!a.plan) return b;
  return b.plan.costo < a.plan.costo ? b : a;
}
