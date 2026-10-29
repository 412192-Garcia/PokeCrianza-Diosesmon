// Lectura y limpieza del export crudo del PC (formato tipo Showdown).
import { STAT_INDEX, ZERO_SHIFT, pokemon } from "./model.js";

// Especies cuyo nombre base lleva guion legítimamente (no es una forma regional).
// La Dex cubre cualquier otro caso; esta lista garantiza los conocidos aunque falte.
const HYPHENATED_BASE = new Set([
  "ho-oh", "porygon-z", "jangmo-o", "hakamo-o", "kommo-o",
  "ting-lu", "chien-pao", "wo-chien", "chi-yu", "nidoran-f", "nidoran-m",
]);

const APOSTROPHES = /[’‘ʼ´`]/g;
const GENDER_RE = /\((M|F)\)\s*$/i;
const NICK_RE = /^(.*?)\s*\(([^()]+)\)\s*$/;
const IV_RE = /(\d+)\s*(HP|Atk|Def|SpA|SpD|Spe)\b/gi;
const NATURE_RE = /^([A-Za-z]+)\s+Nature\s*$/i;
const SHINY_RE = /^Shiny:\s*Yes\s*$/i;
const LEVEL_RE = /^Level:\s*(\d+)/i;

const capitalize = s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

export function cleanText(text) {
  return text.replace(/^﻿+/, "").replace(APOSTROPHES, "'").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** 'Lilligant-Hisui' -> 'Lilligant', pero respeta 'Ho-Oh', 'Porygon-Z', 'Ting-Lu'... */
export function stripForm(name, dex) {
  if (!name.includes("-") || HYPHENATED_BASE.has(name.toLowerCase()) || dex.isBaseName(name)) return name;
  return name.split("-")[0];
}

/** Devuelve [especie_cruda, género] desde 'Nick (Especie) (F) @ Objeto'. */
export function parseHeader(line, dex) {
  let head = line.split(" @ ")[0].trim();
  let gender = null;
  const g = GENDER_RE.exec(head);
  if (g) {
    gender = g[1].toUpperCase();
    head = head.slice(0, g.index).trim();
  }
  const n = NICK_RE.exec(head);
  if (n) head = n[2].trim();  // 'Apodo (Especie)'
  head = head.replace(/♀/g, "-F").replace(/♂/g, "-M");
  return [stripForm(head, dex), gender];
}

/**
 * Devuelve { pokemon, excluded, sinGenes }.
 * excluded: [línea, cabecera, motivo]. sinGenes: los que no tienen ningún IV en 31
 * ni en 0 (también figuran en excluded) y sirven de relleno para pasar la especie.
 */
export function parseExport(text, dex) {
  const result = { pokemon: [], excluded: [], sinGenes: [] };
  const lines = cleanText(text).split("\n");

  const blocks = [];
  let current = [], start = 0;
  lines.forEach((raw, i) => {
    const t = raw.trim();
    if (t) {
      if (!current.length) start = i + 1;
      current.push(t);
    } else if (current.length) {
      blocks.push([start, current]);
      current = [];
    }
  });
  if (current.length) blocks.push([start, current]);

  blocks.forEach(([lineNo, block], idx) => {
    const uid = idx + 1;
    const header = block[0];
    let [rawSpecies, gender] = parseHeader(header, dex);
    const species = dex.canonical(rawSpecies);
    if (species === null) {
      result.excluded.push([lineNo, header, `especie desconocida '${rawSpecies}'`]);
      return;
    }

    let shiny = false, nature = null, ivsLine = null, level = null, m;
    for (const ln of block.slice(1)) {
      if (SHINY_RE.test(ln)) shiny = true;
      else if (ln.toLowerCase().startsWith("ivs:")) ivsLine = ln;
      else if ((m = NATURE_RE.exec(ln))) nature = capitalize(m[1]);
      else if ((m = LEVEL_RE.exec(ln))) level = parseInt(m[1], 10);
    }

    const raw = [null, null, null, null, null, null];
    let mask = 0;
    for (const [, value, stat] of (ivsLine ?? "").matchAll(IV_RE)) {
      const i = STAT_INDEX[stat.toLowerCase()], v = parseInt(value, 10);
      raw[i] = v;
      if (v === 31) mask |= 1 << i;
      else if (v === 0) mask |= 1 << (ZERO_SHIFT + i);
    }

    if (shiny) {
      result.excluded.push([lineNo, header, "shiny"]);
      return;
    }
    if (ivsLine === null) {
      result.excluded.push([lineNo, header, "sin línea de IVs"]);
      return;
    }
    // Especies mono-género o sin género: el género sale de la Dex, no del texto.
    const policy = dex.genderPolicy(species);
    if (policy === "M" || policy === "F") gender = policy;
    else if (policy === "N") gender = null;
    else if (gender === null) {
      result.excluded.push([lineNo, header, "género no indicado"]);
      return;
    }

    const mon = pokemon(uid, species, gender, nature, mask, lineNo, level, raw);
    if (!mask) {
      result.excluded.push([lineNo, header, "ningún IV en 31 ni en 0"]);
      result.sinGenes.push(mon);
      return;
    }
    result.pokemon.push(mon);
  });
  return result;
}
