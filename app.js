'use strict';
/* Piano quotidien : affiche la fiche du jour, enregistre les réponses dans le dépôt GitHub privé. */

// ---------- Stockage local (confort : brouillons, cache, file d'envoi) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* idem */ } },
};
const CLE_CONFIG = 'pq-config';
const CLE_CACHE = 'pq-cache';
const CLE_FILE = 'pq-file-envoi';
const cleBrouillon = (n) => `pq-brouillon-${n}`;

const AXES = {
  lec: { nom: 'Lecture à vue', icone: '🎼' },
  ore: { nom: 'Oreille', icone: '👂' },
  ryt: { nom: 'Rythme', icone: '🥁' },
  har: { nom: 'Harmonie', icone: '🃏' },
  cla: { nom: 'Clavier', icone: '🎹' },
};
const AUTOEVAL_STANDARD = [{ id: 'global', question: 'Comment ça s’est passé ?', options: [['Sans hésiter', 1], ['Avec hésitations', 0.6], ['Pas réussi', 0.2]] }];

const config = () => ({ proprietaire: 'klem88', depot: 'piano-quotidien-donnees', jeton: '', ...store.get(CLE_CONFIG, {}) });
const pad = (n) => String(n).padStart(3, '0');

// ---------- API GitHub ----------
async function gh(chemin, opts = {}) {
  const c = config();
  if (!c.jeton) throw new Error('SANS_JETON');
  const rep = await fetch(`https://api.github.com/repos/${c.proprietaire}/${c.depot}/contents/${chemin}`, {
    method: opts.method || 'GET',
    body: opts.body,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${c.jeton}`,
      Accept: opts.brut ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (rep.status === 404) return null;
  if (!rep.ok) throw new Error(`GitHub ${rep.status}`);
  return opts.brut ? rep.text() : rep.json();
}
async function lireJson(chemin) { const t = await gh(chemin, { brut: true }); return t == null ? null : JSON.parse(t); }
function base64(texte) {
  const octets = new TextEncoder().encode(texte);
  let bin = '';
  for (let i = 0; i < octets.length; i += 0x8000) bin += String.fromCharCode(...octets.subarray(i, i + 0x8000));
  return btoa(bin);
}
async function ecrire(chemin, texte, message) {
  const existant = await gh(chemin);
  await gh(chemin, { method: 'PUT', body: JSON.stringify({ message, content: base64(texte), sha: existant?.sha }) });
}

// ---------- État de l'application ----------
const etat = {
  vue: 'fiche',
  cache: store.get(CLE_CACHE, { fiches: {}, faits: [], etat: null }),
  ficheOuverte: null, // numéro affiché depuis l'historique
  erreur: null,
};
const faits = () => new Set([...etat.cache.faits, ...store.get(CLE_FILE, []).map((r) => r.numero)]);
const numerosFiches = () => Object.keys(etat.cache.fiches).map(Number).sort((a, b) => a - b);
const ficheDuJour = () => numerosFiches().find((n) => !faits().has(n));

// Mode démo (développement local) : ?demo lit ../donnees sans GitHub ; les résultats restent sur l'appareil.
const DEMO = new URLSearchParams(location.search).has('demo');
async function synchroniserDemo() {
  const lire = async (u) => { const r = await fetch(u, { cache: 'no-store' }); return r.ok ? r.json() : null; };
  const fiches = {};
  for (let n = 1; ; n++) { const d = await lire(`../donnees/fiches/${pad(n)}.json`); if (!d) break; fiches[n] = { sha: 'demo', data: d }; }
  const demoFaits = store.get('pq-demo-faits', []);
  for (const r of store.get(CLE_FILE, [])) demoFaits.push(r.numero);
  store.set('pq-demo-faits', demoFaits); store.set(CLE_FILE, []);
  etat.cache = { fiches, faits: demoFaits, etat: await lire('../donnees/etat.json') };
  indiquer('Mode démo');
  afficher();
}

async function synchroniser() {
  if (DEMO) return synchroniserDemo();
  indiquer('Synchronisation…');
  try {
    await viderFile();
    const [liste, resultats, etatDistant] = await Promise.all([gh('fiches'), gh('resultats'), lireJson('etat.json')]);
    const fiches = {};
    for (const f of (liste || []).filter((f) => /^\d+\.json$/.test(f.name))) {
      const n = parseInt(f.name, 10);
      const ancien = etat.cache.fiches[n];
      fiches[n] = ancien && ancien.sha === f.sha ? ancien : { sha: f.sha, data: await lireJson(`fiches/${f.name}`) };
    }
    etat.cache = {
      fiches,
      faits: (resultats || []).filter((f) => /^\d+\.json$/.test(f.name)).map((f) => parseInt(f.name, 10)),
      etat: etatDistant,
    };
    store.set(CLE_CACHE, etat.cache);
    etat.erreur = null;
    indiquer(`À jour · ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`);
  } catch (e) {
    etat.erreur = e.message;
    indiquer(e.message === 'SANS_JETON' ? 'Non configuré' : 'Hors ligne (copie locale)');
  }
  afficher();
}
async function viderFile() {
  if (DEMO) return synchroniserDemo();
  const file = store.get(CLE_FILE, []);
  const restant = [];
  for (const r of file) {
    try {
      await ecrire(`resultats/${pad(r.numero)}.json`, JSON.stringify(r, null, 2) + '\n', `Résultat de la fiche ${r.numero}`);
      etat.cache.faits.push(r.numero);
    } catch { restant.push(r); }
  }
  store.set(CLE_FILE, restant);
  store.set(CLE_CACHE, etat.cache);
}
function indiquer(t) { document.getElementById('etat-sync').textContent = t; }

// ---------- Petits utilitaires d'affichage ----------
function h(tag, attrs = {}, ...enfants) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const e of enfants.flat()) if (e != null && e !== false) el.append(e.nodeType ? e : document.createTextNode(e));
  return el;
}
function echapper(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function markdown(s = '') {
  const lignes = echapper(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').split('\n');
  let out = '', liste = false, para = [];
  const fermerPara = () => { if (para.length) { out += `<p>${para.join('<br>')}</p>`; para = []; } };
  for (const l of lignes) {
    if (/^\s*-\s+/.test(l)) { fermerPara(); if (!liste) { out += '<ul>'; liste = true; } out += `<li>${l.replace(/^\s*-\s+/, '')}</li>`; continue; }
    if (liste) { out += '</ul>'; liste = false; }
    if (!l.trim()) fermerPara(); else para.push(l);
  }
  fermerPara(); if (liste) out += '</ul>';
  return h('div', { class: 'texte', html: out });
}
function melanger(tab, graine) {
  let s = [...graine].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const alea = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const r = [...tab];
  for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(alea() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; }
  return r;
}

// ---------- Son ----------
let actx = null, sortie = null;
function audio() {
  if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === 'suspended') actx.resume();
  return actx;
}
const DEMI_TONS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function midi(nom) {
  const m = /^([A-G])([#b]*)(-?\d)$/.exec(nom);
  if (!m) return 60;
  let v = DEMI_TONS[m[1]];
  for (const c of m[2]) v += c === '#' ? 1 : -1;
  return 12 * (parseInt(m[3], 10) + 1) + v;
}
function jouerEtapes(etapes, duree = 1) {
  const c = audio();
  if (sortie) { sortie.gain.setTargetAtTime(0, c.currentTime, 0.02); }
  sortie = c.createGain(); sortie.gain.value = 0.9; sortie.connect(c.destination);
  const t0 = c.currentTime + 0.06;
  etapes.forEach((notes, i) => {
    const t = t0 + i * duree;
    const vel = 0.22 / Math.sqrt(Math.max(1, notes.length));
    for (const n of notes) note(c, sortie, t, 440 * 2 ** ((midi(n) - 69) / 12), Math.max(duree, 0.7), vel);
  });
}
function note(c, dest, t, f, duree, vel) {
  // timbre de piano simplifié : quelques partiels qui s'éteignent d'autant plus vite qu'ils sont aigus
  [[1, 1], [2, 0.45], [3, 0.2], [4, 0.1]].forEach(([k, a]) => {
    const o = c.createOscillator(), g = c.createGain();
    o.frequency.value = f * k; o.type = 'sine';
    const fin = t + duree * (1.6 / k) + 0.3;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel * a, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0008, fin);
    o.connect(g); g.connect(dest); o.start(t); o.stop(fin + 0.05);
  });
}

// Lecture d'une partition ABC avec abcjs (après avoir joué, pour vérifier)
let synthEnCours = null;
async function ecouterAbc(objetVisuel, bouton) {
  if (!window.ABCJS?.synth?.supportsAudio()) return;
  if (synthEnCours) { synthEnCours.stop(); synthEnCours = null; bouton.textContent = '▶ Écouter'; return; }
  bouton.textContent = 'Chargement…';
  const s = new ABCJS.synth.CreateSynth();
  await s.init({ audioContext: audio(), visualObj: objetVisuel });
  await s.prime();
  s.start(); synthEnCours = s; bouton.textContent = '■ Arrêter';
}
function rendreAbc(conteneur, abc) {
  if (!window.ABCJS) { conteneur.textContent = 'Partition indisponible (hors ligne ?)'; return null; }
  const largeur = Math.max(280, (conteneur.clientWidth || 340) - 8);
  return ABCJS.renderAbc(conteneur, abc, {
    responsive: 'resize', add_classes: true, staffwidth: largeur, paddingleft: 4, paddingright: 4,
    wrap: { minSpacing: 1.6, maxSpacing: 2.6, preferredMeasuresPerLine: 4 },
  })[0];
}

// Métronome
function metronome(tempoInitial, temps) {
  let tempo = tempoInitial, minuterie = null, prochain = 0, battement = 0;
  const voyant = h('span', { class: 'voyant' });
  const affichage = h('span', { class: 'tempo' });
  const majAffichage = () => { affichage.innerHTML = `${tempo} <small>bpm</small>`; };
  const clic = (t, fort) => {
    const c = audio(), o = c.createOscillator(), g = c.createGain();
    o.frequency.value = fort ? 1600 : 1000;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(fort ? 0.5 : 0.3, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + 0.06);
    const delai = Math.max(0, (t - c.currentTime) * 1000);
    setTimeout(() => { voyant.classList.add('on'); setTimeout(() => voyant.classList.remove('on'), 90); }, delai);
  };
  const boucle = () => {
    const c = audio();
    while (prochain < c.currentTime + 0.12) { clic(prochain, battement % temps === 0); prochain += 60 / tempo; battement++; }
  };
  const bascule = h('button', { class: 'bouton', onclick: () => {
    if (minuterie) { clearInterval(minuterie); minuterie = null; bascule.textContent = '▶ Métronome'; return; }
    battement = 0; prochain = audio().currentTime + 0.1; minuterie = setInterval(boucle, 25); bascule.textContent = '■ Stop';
  } }, '▶ Métronome');
  const changer = (d) => { tempo = Math.min(200, Math.max(30, tempo + d)); majAffichage(); };
  majAffichage();
  const el = h('div', { class: 'metronome' }, bascule,
    h('button', { class: 'bouton', onclick: () => changer(-4), 'aria-label': 'Plus lent' }, '−'), affichage,
    h('button', { class: 'bouton', onclick: () => changer(4), 'aria-label': 'Plus rapide' }, '+'), voyant);
  el.arreter = () => { if (minuterie) { clearInterval(minuterie); minuterie = null; } };
  el.tempo = () => tempo;
  return el;
}
const arretsSurNavigation = [];

// ---------- Fiche ----------
function brouillon(n) { return store.get(cleBrouillon(n), { debut: new Date().toISOString(), items: {}, ressenti: null, note: '' }); }
function sauver(n, b) { store.set(cleBrouillon(n), b); }

function vueFiche(numero, lectureSeule) {
  const fiche = etat.cache.fiches[numero]?.data;
  if (!fiche) return h('div', {}, h('p', {}, 'Fiche introuvable.'));
  const b = brouillon(numero);
  const axe = AXES[fiche.axe] || { nom: fiche.axe, icone: '•' };
  const racine = h('div');
  racine.append(h('section', { class: 'carte' },
    h('div', { class: 'surtitre' }, `${axe.icone} ${axe.nom} · fiche ${fiche.numero}`),
    h('h2', { class: 'titre-fiche' }, fiche.titre),
    h('div', { class: 'meta' }, `≈ ${fiche.duree || 10} min${fiche.niveau ? ` · niveau ${fiche.niveau}` : ''}`),
    fiche.intro ? markdown(fiche.intro) : null));
  fiche.blocs.forEach((bloc, i) => racine.append(vueBloc(bloc, i, numero, b)));
  racine.append(lectureSeule ? h('p', { class: 'note-douce' }, 'Fiche déjà faite : tu peux la refaire pour t’entraîner, sans renvoyer de résultat.') : vueFin(numero, fiche, b));
  return racine;
}

function vueBloc(bloc, i, numero, b) {
  switch (bloc.type) {
    case 'texte': return h('section', { class: 'carte' }, markdown(bloc.contenu));
    case 'cartes': case 'oreille': return vueQuestions(bloc, numero, b);
    case 'partition': return vueJeu(bloc, numero, b, 'partition');
    case 'rythme': return vueJeu(bloc, numero, b, 'rythme');
    case 'tache': return vueJeu(bloc, numero, b, 'tache');
    default: return h('section', { class: 'carte' }, `Bloc inconnu : ${bloc.type}`);
  }
}

function vueQuestions(bloc, numero, b) {
  const items = bloc.items;
  const sec = h('section', { class: 'carte' });
  const premierNonFait = () => items.findIndex((it) => !b.items[it.id]);
  let index = premierNonFait();

  const rendre = () => {
    sec.innerHTML = '';
    const faitsIci = items.filter((it) => b.items[it.id]).length;
    if (index === -1) {
      const justes = items.filter((it) => b.items[it.id]?.correct).length;
      const rates = items.filter((it) => b.items[it.id] && !b.items[it.id].correct);
      sec.append(h('h3', {}, `${justes} / ${items.length} bonnes réponses`));
      if (rates.length) {
        sec.append(h('p', { class: 'note-douce' }, 'À retenir :'));
        sec.append(h('ul', { class: 'liste' }, rates.map((it) => h('li', {}, h('div', { class: 't' },
          h('strong', {}, it.enonce), h('br'), `→ ${it.reponse}. `, h('span', { class: 'note-douce' }, it.explication || ''))))));
      }
      sec.append(h('div', { class: 'rangee' }, h('button', { class: 'bouton', onclick: () => { index = 0; rendre(); } }, 'Revoir les questions')));
      return;
    }
    const it = items[index];
    const dejaRepondu = b.items[it.id];
    sec.append(h('div', { class: 'compteur' }, h('span', {}, `Question ${index + 1} / ${items.length}`), h('span', {}, it.theme || '')));
    sec.append(h('div', { class: 'barre' }, h('i', { style: `width:${(100 * faitsIci) / items.length}%` })));
    if (it.sons) {
      const btn = h('button', { class: 'bouton ecouter', onclick: () => jouerEtapes(it.sons, it.duree || 1) }, '▶ Écouter');
      sec.append(btn);
      if (!dejaRepondu && actx) setTimeout(() => jouerEtapes(it.sons, it.duree || 1), 250);
    }
    sec.append(h('div', { class: 'enonce' }, it.enonce));
    const zoneChoix = h('div', { class: 'choix' });
    const explication = h('div');
    const ordre = it.choix.length > 2 ? melanger(it.choix, it.id) : it.choix;
    const boutons = ordre.map((c) => h('button', { onclick: () => repondre(c) }, c));
    zoneChoix.append(...boutons);
    sec.append(zoneChoix, explication);

    const montrer = (choisi) => {
      boutons.forEach((btn, k) => {
        btn.disabled = true;
        if (ordre[k] === it.reponse) btn.classList.add('juste');
        else if (ordre[k] === choisi) btn.classList.add('faux');
      });
      const ok = choisi === it.reponse;
      explication.replaceChildren(h('div', { class: 'explication' },
        h('strong', { class: ok ? 'ok' : 'ko' }, ok ? 'Juste. ' : `Non : ${it.reponse}. `), it.explication || ''));
      const suivant = () => { const k = items.findIndex((x, j) => j > index && !b.items[x.id]); index = k === -1 ? premierNonFait() : k; rendre(); };
      explication.append(h('div', { class: 'rangee' }, h('button', { class: 'bouton principal', onclick: suivant }, index === items.length - 1 ? 'Terminer' : 'Suivante →')));
    };
    function repondre(c) {
      b.items[it.id] = { id: it.id, niveau: it.niveau, theme: it.theme, type: 'carte', correct: c === it.reponse, score: c === it.reponse ? 1 : 0, reponse: c };
      sauver(numero, b);
      montrer(c);
    }
    if (dejaRepondu) montrer(dejaRepondu.reponse);
  };
  rendre();
  return sec;
}

function vueJeu(bloc, numero, b, genre) {
  const sec = h('section', { class: 'carte' });
  sec.append(h('h3', {}, bloc.titre || ''));
  if (bloc.consigne) sec.append(markdown(bloc.consigne));
  let objetVisuel = null;
  if (bloc.abc) {
    const papier = h('div', { class: 'papier' });
    sec.append(papier);
    requestAnimationFrame(() => { objetVisuel = rendreAbc(papier, bloc.abc); });
  }
  const outils = h('div', { class: 'rangee' });
  if (genre === 'partition') {
    let reste = 60, minuterie = null;
    const btn = h('button', { class: 'bouton minuteur', onclick: () => {
      if (minuterie) return;
      minuterie = setInterval(() => {
        reste--; btn.textContent = `⏱ ${reste} s`;
        if (reste <= 0) { clearInterval(minuterie); btn.textContent = '✓ À toi de jouer'; jouerEtapes([['A5']], 0.4); }
      }, 1000);
      arretsSurNavigation.push(() => clearInterval(minuterie));
    } }, '⏱ 1 min d’observation');
    outils.append(btn);
  }
  if (genre === 'rythme') {
    const m = metronome(bloc.tempo || 72, bloc.temps || 4);
    arretsSurNavigation.push(m.arreter);
    sec.append(m);
  }
  if (bloc.abc) {
    const ecoute = h('button', { class: 'bouton', onclick: () => objetVisuel && ecouterAbc(objetVisuel, ecoute) }, '▶ Écouter');
    outils.append(ecoute, h('span', { class: 'note-douce' }, genre === 'rythme' ? '' : 'après avoir joué'));
  }
  if (outils.childNodes.length) sec.append(outils);
  sec.append(vueAutoeval(bloc, numero, b));
  return sec;
}

function vueAutoeval(bloc, numero, b) {
  const criteres = bloc.autoeval === 'standard' || !bloc.autoeval ? AUTOEVAL_STANDARD : bloc.autoeval;
  const zone = h('div', { class: 'autoeval' });
  const rendre = () => {
    zone.innerHTML = '';
    const pasTente = b.items[`${bloc.id}:pas-tente`];
    for (const cr of criteres) {
      const cle = `${bloc.id}:${cr.id}`;
      const actuel = b.items[cle];
      zone.append(h('div', { class: 'critere' }, h('div', { class: 'q' }, cr.question),
        h('div', { class: 'puces' }, cr.options.map(([label, score]) => h('button', {
          class: actuel?.reponse === label && !pasTente ? 'choisi' : '',
          onclick: () => {
            delete b.items[`${bloc.id}:pas-tente`];
            b.items[cle] = { id: cle, niveau: bloc.niveau, theme: bloc.titre, type: 'autoeval', score, reponse: label };
            sauver(numero, b); rendre();
          },
        }, label)))));
    }
    zone.append(h('div', { class: 'puces' }, h('button', {
      class: pasTente ? 'choisi' : '',
      onclick: () => {
        for (const cr of criteres) delete b.items[`${bloc.id}:${cr.id}`];
        b.items[`${bloc.id}:pas-tente`] = { id: `${bloc.id}:pas-tente`, niveau: bloc.niveau, theme: bloc.titre, type: 'autoeval', score: null, reponse: 'pas tenté' };
        sauver(numero, b); rendre();
      },
    }, 'Pas tenté')));
  };
  rendre();
  return zone;
}

function vueFin(numero, fiche, b) {
  const sec = h('section', { class: 'carte' });
  const rendre = () => {
    sec.innerHTML = '';
    sec.append(h('h3', {}, 'Comment c’était ?'));
    sec.append(h('div', { class: 'ressenti', style: 'margin-top:10px' }, [['facile', 'Trop facile'], ['juste', 'Juste bien'], ['dur', 'Trop dur']].map(([v, l]) =>
      h('button', { class: b.ressenti === v ? 'choisi' : '', onclick: () => { b.ressenti = v; sauver(numero, b); rendre(); } }, l))));
    const zone = h('textarea', { placeholder: 'Une remarque ? (ce qui a coincé, tempo baissé, envie d’aller plus vite…)' });
    zone.value = b.note || '';
    zone.addEventListener('input', () => { b.note = zone.value; sauver(numero, b); });
    sec.append(h('label', {}, 'Remarque (facultatif)'), zone);
    sec.append(h('div', { class: 'rangee' }, h('button', {
      class: 'bouton principal', disabled: !b.ressenti, onclick: () => terminer(numero, fiche, b),
    }, 'Terminer la fiche')));
  };
  rendre();
  return sec;
}

async function terminer(numero, fiche, b) {
  const resultat = {
    numero, axe: fiche.axe, niveau: fiche.niveau ?? null, placement: !!fiche.placement,
    debut: b.debut, fin: new Date().toISOString(),
    items: Object.values(b.items), ressenti: b.ressenti, note: b.note || '',
  };
  store.set(CLE_FILE, [...store.get(CLE_FILE, []).filter((r) => r.numero !== numero), resultat]);
  store.del(cleBrouillon(numero));
  etat.ficheOuverte = null;
  afficher();
  window.scrollTo(0, 0);
  try { await viderFile(); indiquer('Résultat envoyé ✓'); } catch { indiquer('Envoi en attente'); }
  afficher();
}

// ---------- Vues ----------
function vueAccueilFiche() {
  if (!config().jeton && !DEMO) {
    return h('section', { class: 'carte' }, h('h2', {}, 'Bienvenue'),
      h('p', {}, 'Pour commencer, relie la page à ton dépôt de suivi (une seule fois sur ce téléphone).'),
      h('button', { class: 'bouton principal', onclick: () => aller('reglages') }, 'Configurer'));
  }
  if (etat.ficheOuverte != null) return vueFiche(etat.ficheOuverte, faits().has(etat.ficheOuverte));
  const n = ficheDuJour();
  if (n == null) {
    const enAttente = store.get(CLE_FILE, []).length;
    return h('section', { class: 'carte' }, h('h2', {}, 'Tout est fait ✓'),
      h('p', {}, 'La prochaine fiche sera préparée ce soir, adaptée à tes réponses.'),
      enAttente ? h('p', { class: 'note-douce' }, `${enAttente} résultat(s) en attente d’envoi (réseau).`) : null,
      etat.cache.etat?.message ? h('p', { class: 'note-douce' }, etat.cache.etat.message) : null);
  }
  return vueFiche(n, false);
}

function vueProgres() {
  const e = etat.cache.etat;
  const racine = h('div');
  if (!e) return h('section', { class: 'carte' }, h('p', {}, 'Pas encore de données.'));
  if (e.message) racine.append(h('section', { class: 'carte' }, h('div', { class: 'surtitre' }, 'Le mot du prof'), markdown(e.message)));
  const sec = h('section', { class: 'carte' }, h('h3', {}, 'Niveau par axe'));
  for (const [code, ax] of Object.entries(e.axes || {})) {
    const niv = ax.niveau;
    sec.append(h('div', { class: 'axe' },
      h('div', { class: 'ligne' }, h('strong', {}, `${AXES[code]?.icone || ''} ${ax.nom}`), h('span', { class: 'niv' }, niv == null ? 'à situer' : `niveau ${niv} / 10`)),
      h('div', { class: 'echelle', 'aria-hidden': 'true' }, Array.from({ length: 10 }, (_, k) =>
        h('i', { class: [niv != null && k < niv ? 'plein' : '', ax.cible === k + 1 ? 'cible' : ''].join(' ') })))));
  }
  sec.append(h('p', { class: 'legende' }, 'Le carré encadré marque l’objectif de juin.'));
  racine.append(sec);
  const nbFaits = faits().size;
  const rev = (e.revisions || []).length;
  racine.append(h('section', { class: 'carte' },
    h('p', {}, `Fiches faites : `, h('strong', {}, String(nbFaits))),
    h('p', {}, `Points à revoir en file : `, h('strong', {}, String(rev)))));
  const hist = (e.historique || []).slice(-10).reverse();
  if (hist.length) {
    racine.append(h('section', { class: 'carte' }, h('h3', {}, 'Dernières fiches'),
      h('ul', { class: 'liste' }, hist.map((x) => h('li', {}, h('span', { class: 'num' }, `#${x.numero}`),
        h('span', { class: 't' }, `${AXES[x.axe]?.icone || ''} ${AXES[x.axe]?.nom || x.axe}${x.niveau ? ` · niv. ${x.niveau}` : ''}`),
        h('span', { class: 'pastille' }, x.score != null ? `${Math.round(x.score * 100)} %` : '—'))))));
  }
  return racine;
}

function vueHistorique() {
  const f = faits();
  const auj = ficheDuJour();
  const nums = numerosFiches().reverse();
  if (!nums.length) return h('section', { class: 'carte' }, h('p', {}, 'Aucune fiche pour l’instant.'));
  return h('section', { class: 'carte' }, h('h3', {}, 'Toutes les fiches'),
    h('ul', { class: 'liste' }, nums.map((n) => {
      const d = etat.cache.fiches[n].data;
      const statut = f.has(n) ? h('span', { class: 'pastille fait' }, 'faite') : n === auj ? h('span', { class: 'pastille attente' }, 'aujourd’hui') : h('span', { class: 'pastille' }, 'à venir');
      return h('li', { style: 'cursor:pointer', onclick: () => { etat.ficheOuverte = n; aller('fiche'); } },
        h('span', { class: 'num' }, `#${n}`), h('span', { class: 't' }, `${AXES[d.axe]?.icone || ''} ${d.titre}`), statut);
    })));
}

function vueReglages() {
  const c = config();
  const champ = (id, label, valeur, type = 'text') => [h('label', { for: id }, label), h('input', { id, type, value: valeur, autocomplete: 'off', spellcheck: 'false' })];
  const msg = h('p', { class: 'note-douce' });
  const sec = h('section', { class: 'carte' }, h('h3', {}, 'Accès au dépôt de suivi'),
    h('p', { class: 'note-douce', html: 'Tes fiches et tes résultats vivent dans ton dépôt GitHub privé. Crée un <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">jeton à accès précis</a> : accès au seul dépôt <strong>piano-quotidien-donnees</strong>, permission <strong>Contents : Read and write</strong>, expiration après juin 2027. Colle-le ici : il reste sur ce téléphone.' }),
    ...champ('proprietaire', 'Compte GitHub', c.proprietaire),
    ...champ('depot', 'Dépôt', c.depot),
    ...champ('jeton', 'Jeton', c.jeton, 'password'),
    h('div', { class: 'rangee' }, h('button', { class: 'bouton principal', onclick: async () => {
      store.set(CLE_CONFIG, {
        proprietaire: document.getElementById('proprietaire').value.trim(),
        depot: document.getElementById('depot').value.trim(),
        jeton: document.getElementById('jeton').value.trim(),
      });
      msg.textContent = 'Test…';
      await synchroniser();
      msg.textContent = etat.erreur ? `Échec : ${etat.erreur}` : `Connexion réussie : ${numerosFiches().length} fiche(s) trouvée(s).`;
      if (etat.erreur) msg.classList.add('erreur'); else msg.classList.remove('erreur');
      aller('reglages', msg);
    } }, 'Enregistrer et tester')), msg);

  const exp = h('section', { class: 'carte' }, h('h3', {}, 'Exporter mes données'),
    h('p', { class: 'note-douce' }, 'Télécharge tout (fiches, résultats, état, journal, curriculum) dans un seul fichier JSON. Le dépôt GitHub en contient déjà une copie complète.'),
    h('div', { class: 'rangee' }, h('button', { class: 'bouton', onclick: exporter }, '⬇ Exporter')));
  return h('div', {}, sec, exp);
}

async function exporter() {
  indiquer('Export…');
  try {
    const [fiches, resultats] = await Promise.all([gh('fiches'), gh('resultats')]);
    const lire = async (dossier, liste) => Object.fromEntries(await Promise.all((liste || []).filter((f) => f.name.endsWith('.json'))
      .map(async (f) => [f.name, await lireJson(`${dossier}/${f.name}`)])));
    const donnees = {
      exporte_le: new Date().toISOString(),
      etat: await lireJson('etat.json'),
      curriculum: await gh('curriculum.md', { brut: true }),
      journal: await gh('journal.md', { brut: true }),
      fiches: await lire('fiches', fiches),
      resultats: await lire('resultats', resultats),
      en_attente: store.get(CLE_FILE, []),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(donnees, null, 2)], { type: 'application/json' }));
    h('a', { href: url, download: `piano-quotidien-${new Date().toISOString().slice(0, 10)}.json` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    indiquer('Export prêt ✓');
  } catch (e) { indiquer(`Export impossible (${e.message})`); }
}

function aller(vue, apres) {
  etat.vue = vue;
  afficher();
  if (apres) document.getElementById('vue').append(apres);
}
function afficher() {
  while (arretsSurNavigation.length) arretsSurNavigation.pop()();
  if (synthEnCours) { synthEnCours.stop(); synthEnCours = null; }
  const vue = document.getElementById('vue');
  const contenu = { fiche: vueAccueilFiche, progres: vueProgres, historique: vueHistorique, reglages: vueReglages }[etat.vue]();
  vue.replaceChildren(contenu);
  document.querySelectorAll('.onglets button').forEach((b) => b.classList.toggle('actif', b.dataset.vue === etat.vue));
}

document.querySelectorAll('.onglets button').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.vue === 'fiche' && etat.vue === 'fiche') etat.ficheOuverte = null;
  aller(b.dataset.vue);
  window.scrollTo(0, 0);
}));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && config().jeton) synchroniser(); });
afficher();
if (config().jeton || DEMO) synchroniser(); else indiquer('Non configuré');
