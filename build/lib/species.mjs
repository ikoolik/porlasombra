// Species -> crown dimensions, for the Valencia municipal tree inventory.
//
// The inventory carries no height, crown or trunk field at all — the full field list is
// objectid, ud_gestion, tipo_situacion, barrio, lugar, idarbol, nom_botanico, nom_comu_c,
// nom_comu_v, grupo, lpamcv, distrito, shape. So species is not a shortcut to a dimension,
// it is the only route to one. Same move as buildings: no direct measurement available, so
// derive it from the categorical attribute that *is* universal.
//
// Two tiers, because the tail is long. 444 distinct species inside the bbox and the top 30
// only reach 73%, so a per-species table can never be complete. But `grupo` is populated on
// 99.98% of usable records, which makes it a total fallback:
//
//   1. GROUP — four rough classes, covers every tree, poorly.
//   2. SPECIES — overrides for the head of the distribution, covers ~80% at 45 rows.
//
// Adding a row to SPECIES is a pure data change: nothing downstream branches on species, it
// only reads the resolved numbers. The table can grow long after the pipeline ships.
//
// Dimensions are *mature street-tree* figures for Valencia — horticultural literature and
// typical municipal planting practice, not measurement. They are deliberately conservative:
// a park specimen of the same species is usually larger than one in a pavement pit. Treat
// them as a first calibration to be checked against reality, not as ground truth.
//
// Fields, all metres except tau:
//   h     total height
//   cd    crown diameter
//   cb    crown base — height of the underside of the canopy above the pavement.
//         This is the field a building does not have and the one that matters most: a
//         heightmap says "occluder top is at h" and shades everything below it, which is
//         exact for a prism standing on the ground and wrong for a crown with open air
//         under it. Trees are a slab (cb..h), not a height.
//   tau   fraction of light passing through the crown in full leaf. 0 = opaque like a
//         building, 1 = invisible. Dense broadleaf ~0.12, airy legume ~0.30, palm ~0.60.
//   dec   deciduous. Drives the winter tau, see TAU_BARE.

// Transmittance of a bare deciduous crown. Not 1.0: trunk, branch structure and twigs still
// intercept a useful fraction, which is why a winter plane avenue is not quite an open street.
export const TAU_BARE = 0.78;

// Fallbacks by `grupo`. Every usable record has one of these, so nothing goes undimensioned.
// Quality is rough by construction — Palmacea alone spans a 3 m Chamaerops and a 25 m
// Washingtonia — but it is the difference between a tree existing in the model and not.
export const GROUP = {
  "Caduco":                { h: 10, cd:  7, cb: 2.5, tau: 0.18, dec: true  },
  "Perenne":               { h:  8, cd:  6, cb: 2.2, tau: 0.14, dec: false },
  "Conifera":              { h: 12, cd:  5, cb: 2.0, tau: 0.12, dec: false },
  "Palmacea":              { h: 10, cd:  4, cb: 6.0, tau: 0.60, dec: false },
  "Arbusto arb/trep.":     { h:  3, cd:  2.5, cb: 0.4, tau: 0.25, dec: false },
  "Arbusto arborescente":  { h:  3, cd:  2.5, cb: 0.4, tau: 0.25, dec: false },
  "SD":                    { h:  8, cd:  6, cb: 2.2, tau: 0.20, dec: false },
};

// Per-species overrides, roughly in descending abundance inside the bbox. The share comments
// are measured against the 144,593 usable in-bbox trees; the running total is what this table
// actually covers.
export const SPECIES = {
  // --- broadleaf, the bulk ---
  "Citrus aurantium":              { h:  6, cd:  4.5, cb: 1.5, tau: 0.10, dec: false }, // 7.9% bitter orange, dense and low
  "Platanus x hispanica":          { h: 20, cd: 13,   cb: 3.5, tau: 0.10, dec: true  }, // 6.8% plane, the big avenue tree
  "Celtis australis":              { h: 16, cd: 11,   cb: 3.0, tau: 0.14, dec: true  }, // 5.4% lledoner
  "Melia azedarach":               { h: 10, cd:  8,   cb: 2.5, tau: 0.22, dec: true  }, // 5.2% open, late to leaf out
  "Jacaranda mimosifolia":         { h: 12, cd:  9,   cb: 2.5, tau: 0.28, dec: true  }, // 3.6% airy bipinnate leaf
  "Morus alba 'Fruitless'":        { h: 10, cd:  9,   cb: 2.5, tau: 0.12, dec: true  }, // 3.0% usually pollarded, very dense
  "Brachychiton populneus":        { h: 12, cd:  7,   cb: 2.5, tau: 0.14, dec: false }, // 2.9%
  "Cercis siliquastrum":           { h:  7, cd:  6,   cb: 2.0, tau: 0.18, dec: true  }, // 2.5%
  "Acer negundo":                  { h: 12, cd:  9,   cb: 2.5, tau: 0.18, dec: true  }, // 2.5%
  "Tipuana tipu":                  { h: 16, cd: 14,   cb: 3.0, tau: 0.20, dec: true  }, // 2.0% very broad crown
  "Styphnolobium japonicum":       { h: 14, cd: 11,   cb: 3.0, tau: 0.20, dec: true  }, // 2.0% sophora
  "Ligustrum japonicum":           { h:  6, cd:  5,   cb: 2.0, tau: 0.10, dec: false }, // 1.9% dense evergreen
  "Morus alba":                    { h: 11, cd:  9,   cb: 2.5, tau: 0.12, dec: true  }, // 1.4%
  "Ficus microcarpa":              { h: 14, cd: 14,   cb: 2.5, tau: 0.08, dec: false }, // 1.4% densest shade in the city
  "Grevillea robusta":             { h: 16, cd:  8,   cb: 3.0, tau: 0.22, dec: false }, // 1.3%
  "Ligustrum japonicum 'Variegata'": { h: 5, cd: 4,   cb: 1.8, tau: 0.12, dec: false }, // 1.3%
  "Olea europaea":                 { h:  7, cd:  6,   cb: 1.8, tau: 0.22, dec: false }, // 1.1% olive, grey and open
  "Ulmus pumila":                  { h: 14, cd: 10,   cb: 3.0, tau: 0.16, dec: true  }, // 1.0%
  "Fraxinus angustifolia":         { h: 15, cd: 10,   cb: 3.0, tau: 0.18, dec: true  }, // 0.9%
  "Pyrus calleryana 'Chanticleer'": { h: 9, cd:  5,   cb: 2.2, tau: 0.14, dec: true  }, // 0.8% narrow upright
  "Quercus ilex":                  { h: 12, cd: 10,   cb: 2.5, tau: 0.10, dec: false }, // 0.8% holm oak, dense
  "Fraxinus ornus":                { h: 10, cd:  8,   cb: 2.5, tau: 0.18, dec: true  }, // 0.8%
  "Brachychiton acerifolius":      { h: 14, cd:  8,   cb: 3.0, tau: 0.16, dec: true  }, // 0.6%
  "Lagunaria patersonii":          { h: 10, cd:  7,   cb: 2.5, tau: 0.12, dec: false }, // 0.6%
  "Morus nigra":                   { h: 10, cd:  9,   cb: 2.5, tau: 0.12, dec: true  }, // 0.6%
  "Robinia pseudoacacia":          { h: 14, cd:  9,   cb: 3.0, tau: 0.24, dec: true  }, // 0.5% open pinnate
  "Pittosporum tobira":            { h:  4, cd:  3.5, cb: 0.8, tau: 0.12, dec: false }, // 0.5% shrubby
  "Koelreuteria paniculata":       { h: 10, cd:  8,   cb: 2.5, tau: 0.22, dec: true  }, // 0.5%
  "Bauhinia variegata":            { h:  8, cd:  7,   cb: 2.2, tau: 0.20, dec: true  }, // 0.5%
  "Prunus cerasifera 'Pisardii'":  { h:  7, cd:  5,   cb: 2.0, tau: 0.16, dec: true  }, // 0.5%
  "Ginkgo biloba":                 { h: 14, cd:  7,   cb: 3.0, tau: 0.18, dec: true  }, // 0.4%
  "Tamarix gallica":               { h:  6, cd:  5,   cb: 1.5, tau: 0.30, dec: true  }, // 0.4% feathery, very open
  "Ligustrum lucidum":             { h: 10, cd:  8,   cb: 2.5, tau: 0.10, dec: false }, // 0.4%
  "Nerium oleander":               { h:  3, cd:  2.5, cb: 0.3, tau: 0.18, dec: false }, // 0.5% median shrub

  // --- palms: crown is a tuft at the top of a bare trunk ---
  // cb is deliberately close to h. The shading slab is only the frond crown; everything below
  // is open trunk. A generic disc from the ground would shade whole avenues that are in fact
  // sunlit, which is why palms cannot ride on the broadleaf defaults — 14.1% of all trees.
  "Washingtonia robusta":          { h: 20, cd:  4,   cb: 16.0, tau: 0.55, dec: false }, // 4.9% very tall, small crown
  "Phoenix dactylifera hembra":    { h: 16, cd:  9,   cb: 11.0, tau: 0.50, dec: false }, // 2.2% date palm
  "Chamaerops humilis":            { h:  3, cd:  3,   cb:  1.0, tau: 0.45, dec: false }, // 1.7% low, clumping
  "Phoenix dactylifera macho":     { h: 16, cd:  9,   cb: 11.0, tau: 0.50, dec: false }, // 1.1%
  "Phoenix canariensis hembra":    { h: 13, cd: 10,   cb:  7.0, tau: 0.42, dec: false }, // 0.8% dense heavy crown
  "Phoenix canariensis macho":     { h: 13, cd: 10,   cb:  7.0, tau: 0.42, dec: false }, // 0.7%
  "Trachycarpus fortunei":         { h:  8, cd:  3,   cb:  6.0, tau: 0.50, dec: false }, // 0.6%
  "Washingtonia filifera":         { h: 15, cd:  5,   cb: 11.0, tau: 0.52, dec: false }, // 0.5%

  // --- conifers: the group splits into geometric opposites ---
  // Cupressus is a narrow column, Pinus a wide flat parasol on a high bare trunk. Lumping them
  // under one Conifera default is worse than useless, which is why both are pinned here.
  "Cupressus sempervirens":        { h: 16, cd:  2.5, cb: 1.0, tau: 0.06, dec: false }, // 2.5% columnar, near-opaque
  "Pinus pinea":                   { h: 16, cd: 13,   cb: 7.0, tau: 0.20, dec: false }, // 2.1% stone pine parasol
  "Pinus halepensis":              { h: 14, cd:  9,   cb: 5.0, tau: 0.24, dec: false }, // 1.0% aleppo, open
};

// Species values that are not trees. `Falta` is an empty tree pit — 6.1% of the raw inventory.
// Left in, the model would shade streets that are actually bare.
export const NOT_A_TREE = new Set(["Falta", "SD", ""]);

// Resolve one inventory record to crown dimensions, species table first, group fallback second.
// Returns null for anything that is not a standing tree.
export function resolve(nomBotanico, grupo) {
  const name = (nomBotanico || "").trim();
  if (NOT_A_TREE.has(name)) return null;
  return SPECIES[name] || GROUP[grupo] || GROUP["SD"];
}
