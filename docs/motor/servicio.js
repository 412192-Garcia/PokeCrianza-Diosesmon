// Orquestación: parsea el PC, busca el árbol y lo devuelve como datos listos para la página.
import { CotaDP, INF } from "./cotas.js";
import { toId } from "./dex.js";
import { EVERSTONE, Leaf, Breed, STATS, ZERO_SHIFT, geneStat, geneValue, ivs0, ivs31 } from "./model.js";
import { parseExport, stripForm } from "./parser.js";
import { Planner, SearchLimit, countBreeds, leavesOf, splits } from "./planner.js";

/** Error que se muestra tal cual al usuario. */
export class ErrorUsuario extends Error {}

function* combinaciones(n, k, desde = 0, previo = []) {
  if (previo.length === k) { yield previo; return; }
  for (let i = desde; i < n; i++) yield* combinaciones(n, k, i + 1, [...previo, i]);
}

/** Stats concretos (en 31 y en 0) -> una máscara; si no hay, todas las combinaciones de `cantidad`. */
export function mascaras(stats, cantidad, ceros = []) {
  if (stats.length || ceros.length) {
    const idx = Object.fromEntries(STATS.map((s, i) => [s.toLowerCase(), i]));
    const indice = s => {
      const i = idx[s.toLowerCase()];
      if (i === undefined) throw new ErrorUsuario(`Stat desconocido: ${s.toLowerCase()}`);
      return i;
    };
    const a = new Set(stats.map(indice)), z = new Set(ceros.map(indice));
    if ([...a].some(i => z.has(i))) throw new ErrorUsuario("Un stat no puede estar en 31 y en 0 a la vez.");
    let m = 0;
    for (const i of a) m |= 1 << i;
    for (const i of z) m |= 1 << (ZERO_SHIFT + i);
    return [m];
  }
  const k = cantidad || 5;
  if (!(k >= 1 && k <= 6)) throw new ErrorUsuario("La cantidad de IVs debe estar entre 1 y 6");
  return [...combinaciones(6, k)].map(c => c.reduce((m, i) => m | 1 << i, 0));
}

export function especiesCriables(dex) {
  const nombres = new Set();
  for (const e of Object.values(dex.byId)) {
    if ((e.num ?? 0) <= 0 || e.forme || e.baseSpecies) continue;
    if ((e.eggGroups ?? []).includes("Undiscovered")) continue;
    nombres.add(e.name.replace(/’/g, "'"));
  }
  return [...nombres].sort();
}

function objeto(item) {
  if (item === null || item === undefined) return null;
  if (item === EVERSTONE) return { tipo: "eterna" };
  return { tipo: "recio", stat: geneStat(item), valor: geneValue(item) };
}

/** Identifica a un individuo del PC aunque el archivo se reexporte (especie, género, IVs, naturaleza, línea). */
export const clave = p => `${p.species}|${p.gender ?? "-"}|${p.mask}|${p.nature ?? "-"}|${p.line}`;

// Nombres de stat del buscador de la caja de Cobblemon (ej. "attack_iv=31").
const FILTRO_STATS = ["hp", "attack", "defence", "special_attack", "special_defence", "speed"];

/**
 * Filtro corto para el buscador de la caja (tiene límite de caracteres):
 * especie, nivel, género y UN IV, ej. 'houndour lvl=24 male hp_iv=31'.
 * El IV es el que mejor lo separa de los otros con igual especie, nivel y
 * género; si hay empate, se prefiere un 31/0 y después el de nombre más corto.
 */
export function filtros(pokemon) {
  const base = new Map();
  for (const p of pokemon) {
    const partes = [toId(p.species)];
    if (p.level !== null) partes.push(`lvl=${p.level}`);
    if (p.gender === "M" || p.gender === "F") partes.push(p.gender === "M" ? "male" : "female");
    base.set(p.uid, partes.join(" "));
  }
  const grupos = new Map();
  for (const p of pokemon) {
    const b = base.get(p.uid);
    if (!grupos.has(b)) grupos.set(b, []);
    grupos.get(b).push(p);
  }
  const out = new Map();
  for (const p of pokemon) {
    const b = base.get(p.uid);
    const otros = grupos.get(b).filter(o => o.uid !== p.uid);
    const utiles = [0, 1, 2, 3, 4, 5].filter(i => p.ivs[i] !== null && p.ivs[i] !== undefined);
    if (!utiles.length) { out.set(p.uid, b); continue; }
    const llave = i => [-otros.filter(o => o.ivs[i] !== p.ivs[i]).length,
      p.ivs[i] === 31 || p.ivs[i] === 0 ? 0 : 1, FILTRO_STATS[i].length];
    let mejor = utiles[0], lm = llave(mejor);
    for (const i of utiles.slice(1)) {
      const l = llave(i);
      if (l[0] < lm[0] || (l[0] === lm[0] && (l[1] < lm[1] || (l[1] === lm[1] && l[2] < lm[2])))) { mejor = i; lm = l; }
    }
    out.set(p.uid, `${b} ${FILTRO_STATS[mejor]}_iv=${p.ivs[mejor]}`);
  }
  return out;
}

const generoFijo = (dex, especie) => ({ F: "F", M: "M" })[dex.genderPolicy(especie) ?? ""] ?? null;

/** Pokémon útiles del PC, para elegir cuáles bloquear. */
export function inventario(dex, texto) {
  const parsed = parseExport(texto, dex);
  const fil = filtros(parsed.pokemon);
  return parsed.pokemon.map(p => ({
    clave: clave(p), uid: p.uid, especie: p.species, num: dex.entry(p.species).num,
    genero: p.gender, ivs: ivs31(p.mask), ceros: ivs0(p.mask), naturaleza: p.nature, linea: p.line, filtro: fil.get(p.uid),
  }));
}

function nodo(dex, n, fil, item = null) {
  const base = {
    especie: n.species, num: dex.entry(n.species).num, genero: n.gender, ivs: ivs31(n.mask), ceros: ivs0(n.mask),
    natured: n.natured, objeto: objeto(item), generoFijo: generoFijo(dex, n.species),
    sinGenero: dex.genderPolicy(n.species) === "N",
  };
  if (n instanceof Leaf) {
    const p = n.mon;
    return { ...base, tipo: "pc", uid: p.uid, linea: p.line, naturaleza: p.nature, clave: clave(p), filtro: fil.get(p.uid) };
  }
  return { ...base, tipo: "cria", paso: n.step, conDitto: n.withDitto,
    padres: [nodo(dex, n.p1, fil, n.item1), nodo(dex, n.p2, fil, n.item2)] };
}

const GRUPOS_ES = {
  "Monster": "Monstruo", "Water 1": "Agua 1", "Water 2": "Agua 2", "Water 3": "Agua 3", "Bug": "Bicho",
  "Flying": "Volador", "Field": "Campo", "Fairy": "Hada", "Grass": "Planta", "Human-Like": "Humanoide",
  "Mineral": "Mineral", "Amorphous": "Amorfo", "Ditto": "Ditto", "Dragon": "Dragón", "Undiscovered": "Desconocido",
};
const gruposEs = (dex, especie) => dex.eggGroups(especie).map(g => GRUPOS_ES[g] ?? g);
const genTxt = g => `${STATS[geneStat(g)]} ${geneValue(g)}`;

/** Post-orden: los padres se crían antes que sus hijos. Numera los pasos. */
function numberSteps(root) {
  const order = [];
  const walk = n => {
    if (n instanceof Breed) {
      walk(n.p1);
      walk(n.p2);
      n.step = order.length + 1;
      order.push(n);
    }
  };
  walk(root);
  return order;
}

/** Explica qué le falta al PC para poder armar el árbol (cuando no hay ruta). */
export function diagnostico(dex, pokemon, especie, mask, naturaleza, usarDitto, apartadas = 0) {
  const fam = dex.family(especie);
  const grupos = gruposEs(dex, fam).join(" / ");
  const criables = pokemon.filter(p => dex.canBreed(p.species));
  const dittos = usarDitto ? criables.filter(p => dex.isDitto(p.species)) : [];
  const linea = criables.filter(p => !dex.isDitto(p.species) && dex.family(p.species) === fam);
  const pol = dex.genderPolicy(fam);
  const out = [];

  if (pol === "M" && !dittos.length) {
    out.push(`${fam} no tiene hembras: solo se cría con un Ditto. Conseguí un Ditto.`);
  } else if (pol === "N" && !linea.length) {
    out.push(`No tenés ningún Pokémon de la línea de ${fam}: hace falta uno para que nazca ${fam}.`);
  } else if (!linea.some(p => p.gender === "F" || p.gender === null) && !dittos.length) {
    const extra = apartadas
      ? ` Tenés ${apartadas} hembra${apartadas > 1 ? "s" : ""} de ${fam}, pero ${
        apartadas > 1 ? "las bloqueaste o las usan" : "la bloqueaste o la usa"} otro árbol abierto.`
      : "";
    out.push(`No tenés ninguna hembra útil de la línea de ${fam} (ni un Ditto). Hace falta una para que nazca ${fam}.${extra}`);
  }
  const sinMadre = out.length > 0;  // sin madre posible, lo demás no suma información

  // ¿De dónde puede llegar cada IV? Familias conectadas por grupos huevo con la de la madre.
  const dp = new CotaDP(dex, criables, mask, naturaleza, dittos.length > 0, () => 0, splits);
  const alcanzables = new Set([fam]), pendientes = [fam];
  while (pendientes.length) {
    const f = pendientes.pop();
    for (const h of dp.compat.get(f) ?? []) {
      if (!alcanzables.has(h)) { alcanzables.add(h); pendientes.push(h); }
    }
  }
  const fuentes = criables.filter(p => dex.isDitto(p.species) || alcanzables.has(dex.family(p.species)));
  for (let g = 0; g < 12; g++) {
    if (!(mask >> g & 1)) continue;
    const n = fuentes.filter(p => p.mask >> g & 1).length;
    if (sinMadre) break;
    if (dp.bound(1 << g, false, null, ["exact", fam], false) >= INF) {
      out.push(`Nadie puede pasarle ${genTxt(g)} a ${fam}: conseguí un Pokémon con ${genTxt(g)} ` +
        `del grupo huevo ${grupos} (o ${pol === "N" ? `un ${fam}` : `una ${fam} hembra`} con ese IV).`);
    } else if (n <= 1) {
      out.push(`Solo tenés ${n} Pokémon compatible con ${genTxt(g)}: con uno más hay más caminos.`);
    }
  }
  if (naturaleza && !fuentes.some(p => p.nature === naturaleza)) {
    out.push(`Ningún Pokémon compatible tiene naturaleza ${naturaleza}: conseguí uno (un Ditto sirve).`);
  }

  if (!out.length) {
    const necesarios = dp.bound(mask, !!naturaleza, null, ["exact", fam], false) + 1;
    const conteo = [];
    for (let g = 0; g < 12; g++) if (mask >> g & 1) conteo.push([fuentes.filter(p => p.mask >> g & 1).length, g]);
    conteo.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const escasos = conteo.slice(0, 3).map(([n, g]) => `${genTxt(g)} (${n})`).join(", ");
    out.push(`Cada IV se consigue por separado, pero al criar se gastan los padres y no alcanzan para ` +
      `todo el árbol a la vez (hacen falta al menos ${necesarios} padres). ` +
      `Los IVs con menos Pokémon compatibles son: ${escasos}. Conseguí más de esos, o hembras de ${fam}.`);
  }
  return out;
}

/** Cuenta ocurrencias y las ordena de más a menos (empates: orden de aparición). */
function masComunes(items) {
  const c = new Map();
  for (const x of items) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * Busca la mejor ruta.
 *   pesoCruce: cuánto vale un cruce frente a gastar Pokémon (ver Planner).
 *   pesoEval: peso con el que se informa el costo (por defecto el mismo); sirve
 *             para comparar búsquedas hechas con prioridades distintas.
 */
export function planificar(dex, {
  texto, objetivo, stats = [], cantidad = null, naturaleza = null, usarDitto = true, maxNodos = 3_000_000,
  bloqueados = [], ceros = [], reservados = [], segundos = 30, pesoCruce = 1, pesoEval = null,
}) {
  pesoEval ??= pesoCruce;
  const parsed = parseExport(texto ?? "", dex);
  const todos = [...parsed.pokemon, ...parsed.sinGenes];
  const fil = filtros(todos);
  const vetados = new Set(bloqueados);
  const antes = parsed.pokemon.length;
  parsed.pokemon = parsed.pokemon.filter(p => !vetados.has(clave(p)));
  // Los que ya usan otros árboles abiertos no se pueden usar de nuevo.
  const reservas = new Set(reservados.filter(k => !vetados.has(k)));
  const sinReserva = parsed.pokemon.length;
  parsed.pokemon = parsed.pokemon.filter(p => !reservas.has(clave(p)));
  for (const k of reservas) vetados.add(k);
  const sinGenes = parsed.sinGenes.filter(p => !vetados.has(clave(p)));
  const resumen = {
    utiles: parsed.pokemon.length,
    bloqueados: antes - sinReserva,
    reservados: sinReserva - parsed.pokemon.length,
    descartados: parsed.excluded.length,
    motivos: masComunes(parsed.excluded.map(e => e[2])),
    detalleDescartes: parsed.excluded.map(([linea, cabecera, motivo]) => ({ linea, cabecera, motivo })),
  };
  if (!parsed.pokemon.length) throw new ErrorUsuario("No queda ningún Pokémon útil en el archivo (¿los bloqueaste todos?).");

  const obj = (objetivo ?? "").trim();
  const especie = obj ? dex.canonical(stripForm(obj, dex)) : null;
  if (especie === null) throw new ErrorUsuario(`No conozco la especie '${objetivo}'.`);
  if (!dex.canBreed(especie)) throw new ErrorUsuario(`${especie} es del grupo Undiscovered: no se puede criar.`);
  const familia = dex.family(especie);
  naturaleza = naturaleza ? naturaleza.charAt(0).toUpperCase() + naturaleza.slice(1).toLowerCase() : null;
  // Los que no tienen ningún IV en 31 ni en 0 también entran: no aportan genes,
  // pero sirven de "relleno" donde un padre solo pasa la especie o el género
  // (una madre de la línea objetivo, un padre compatible, un Ditto). Gastarlos no
  // cuesta nada, así nunca se gasta un Pokémon con 31 en ese lugar.
  const inventarioPlan = [...parsed.pokemon, ...sinGenes.filter(p => dex.canBreed(p.species))];

  const intentos = [];
  let mejor = null;
  for (const mask of mascaras(stats, cantidad, ceros)) {
    // 2/3 del tiempo para la búsqueda y 1/3 para mejorar la ruta rama por rama.
    // El tope de nodos crece con el tiempo, si no una búsqueda larga se cortaría antes.
    const planner = new Planner(dex, inventarioPlan, especie, {
      nature: naturaleza, allowDitto: usarDitto, maxNodes: Math.floor(maxNodos * Math.max(1, segundos / 30)),
      timeLimit: segundos * 2 / 3, improveTime: segundos / 3, pesoCruce,
    });
    let plan = null, estado;
    try {
      plan = planner.solve(mask);
      estado = plan ? "ok" : "imposible";
    } catch (e) {
      if (!(e instanceof SearchLimit)) throw e;
      estado = "limite";
    }
    let optimo = planner.optimal;
    if (plan && pesoEval !== pesoCruce) {
      // Costo según la prioridad elegida por el usuario (esta búsqueda usó otra).
      const valor = pesoEval * countBreeds(plan) + leavesOf(plan).reduce((t, l) => t + planner.leafCost(l.mon, true), 0);
      plan = plan instanceof Breed ? plan.with({ cost: valor }) : new Leaf(plan.mon, plan.natured, valor);
      optimo = false;
    }
    intentos.push({ ivs: ivs31(mask), ceros: ivs0(mask), estado, cruces: plan ? countBreeds(plan) : null,
      costo: plan ? plan.cost : null, optimo, nodos: planner.nodes });
    if (plan && (mejor === null || plan.cost < mejor[1].cost)) mejor = [mask, plan, optimo];
  }

  const out = {
    especie, familia, gruposHuevo: gruposEs(dex, familia), naturaleza, inventario: resumen, intentos, plan: null,
    generoFijo: generoFijo(dex, familia),
  };
  if (mejor === null) {
    const apartadas = todos.filter(p => vetados.has(clave(p)) && p.gender === "F" && dex.family(p.species) === familia).length;
    out.faltantes = diagnostico(dex, inventarioPlan, especie, mascaras(stats, cantidad, ceros)[0], naturaleza, usarDitto, apartadas);
    return out;
  }

  const [mask, plan, optimo] = mejor;
  const pasos = numberSteps(plan);
  const hojas = leavesOf(plan);
  out.plan = {
    ivs: ivs31(mask),
    ceros: ivs0(mask),
    cruces: pasos.length,
    costo: plan.cost,
    optimo,
    arbol: nodo(dex, plan, fil),
    pasos: pasos.map(b => ({
      paso: b.step,
      // Los padres van sin su sub-árbol: ya están completos en `arbol`.
      padres: [nodo(dex, b.p1, fil, b.item1), nodo(dex, b.p2, fil, b.item2)].map(({ padres, ...resto }) => resto),
      cria: { especie: b.species, num: dex.entry(b.species).num, genero: b.gender, generoFijo: generoFijo(dex, b.species),
        sinGenero: dex.genderPolicy(b.species) === "N", ivs: ivs31(b.mask), ceros: ivs0(b.mask), natured: b.natured },
      conDitto: b.withDitto,
    })),
    consumidos: [...hojas].sort((a, b) => a.mon.uid - b.mon.uid).map(h => ({
      clave: clave(h.mon), filtro: fil.get(h.mon.uid), uid: h.mon.uid, especie: h.mon.species, genero: h.mon.gender,
      ivs: ivs31(h.mon.mask), ceros: ivs0(h.mon.mask), naturaleza: h.mon.nature, linea: h.mon.line,
    })),
  };
  return out;
}
