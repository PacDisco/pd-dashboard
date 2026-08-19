/**
 * Shared T-shirt / shipping helpers — the single source of truth for turning
 * messy human-entered data into something Shopify's Admin API will accept.
 *
 * Two consumers:
 *   - enrollment.js    reads shirt size + home address out of the Jotform
 *                      application and HubSpot, normalises both, and ships
 *                      them to the Enrollment dashboard.
 *   - shirt-orders.mjs takes what the dashboard posts back and builds the
 *                      Shopify order.
 *
 * ------------------------------------------------------------------------
 * WHY NORMALISATION IS NEEDED
 * ------------------------------------------------------------------------
 * The Jotform application asks "Please choose your t-shirt size" and offers
 * X-small / Small / Medium / Large / X-large. The Shopify variants are titled
 * XS / S / M / L / XL / 2XL / 3XL. The HubSpot contact property
 * `t_shirt_size_` mirrors the Jotform wording; the (barely used) deal property
 * `pd_t_shirt_size` uses the short codes. So four vocabularies describe the
 * same five-to-seven sizes. normalizeShirtSize() collapses them all.
 *
 * Addresses are worse. Shopify's MailingAddressInput wants `countryCode`
 * (ISO 3166-1 alpha-2) and `provinceCode`, but the application collects free
 * text ("United States", "USA", "Uk", "England") and HubSpot's country
 * picklist contains entries like "United Chated" and "cst". countryCodeFor()
 * and provinceCodeFor() do best-effort resolution; anything they can't resolve
 * comes back empty and the dashboard makes the human fix it before submitting.
 *
 * CommonJS on purpose — matches _shared/onboarding-reset.js, and esbuild
 * happily default-imports it from the ESM functions.
 */

// ═══════════════════════════════════════════
// SHIRT SIZES
// ═══════════════════════════════════════════
// `code` matches the Shopify variant title exactly. Order matters: it drives
// the dropdown order in the dashboard.
const SHIRT_SIZES = [
  { code: 'XS',  label: 'XS (X-small)',  aliases: ['xs', 'x-small', 'xsmall', 'x small', 'extra small', 'extra-small'] },
  { code: 'S',   label: 'S (Small)',     aliases: ['s', 'small', 'sm'] },
  { code: 'M',   label: 'M (Medium)',    aliases: ['m', 'medium', 'med'] },
  { code: 'L',   label: 'L (Large)',     aliases: ['l', 'large', 'lg'] },
  { code: 'XL',  label: 'XL (X-large)',  aliases: ['xl', 'x-large', 'xlarge', 'x large', 'extra large', 'extra-large'] },
  { code: '2XL', label: '2XL (XX-large)', aliases: ['2xl', 'xxl', 'xx-large', 'xxlarge', '2x', '2x-large'] },
  { code: '3XL', label: '3XL (XXX-large)', aliases: ['3xl', 'xxxl', 'xxx-large', 'xxxlarge', '3x', '3x-large'] },
];

const SIZE_LOOKUP = new Map();
for (const s of SHIRT_SIZES) {
  SIZE_LOOKUP.set(s.code.toLowerCase(), s.code);
  for (const a of s.aliases) SIZE_LOOKUP.set(a, s.code);
}

/**
 * Collapse any of the four size vocabularies to a Shopify variant title.
 * Returns null for anything unrecognised — callers must treat null as
 * "no size on file" rather than guessing, because guessing a shirt size wrong
 * costs a shirt and a shipping label.
 */
function normalizeShirtSize(raw) {
  if (raw === null || raw === undefined) return null;
  // Jotform multi-select answers arrive as arrays; take the first real entry.
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const hit = normalizeShirtSize(item);
      if (hit) return hit;
    }
    return null;
  }
  let s = String(raw).trim().toLowerCase();
  if (!s) return null;
  // Strip trailing punctuation and collapse whitespace: "Medium " / "Medium." / "X - large"
  s = s.replace(/[.,;:!?]+$/g, '').replace(/\s+/g, ' ').trim();
  if (SIZE_LOOKUP.has(s)) return SIZE_LOOKUP.get(s);
  // Some answers carry a parenthetical or a chest measurement: "Medium (38-40)"
  const bare = s.split('(')[0].trim();
  if (SIZE_LOOKUP.has(bare)) return SIZE_LOOKUP.get(bare);
  // Hyphen/space-insensitive last pass: "x_large", "xLarge"
  const squashed = bare.replace(/[\s_-]/g, '');
  for (const [key, code] of SIZE_LOOKUP.entries()) {
    if (key.replace(/[\s_-]/g, '') === squashed) return code;
  }
  return null;
}

// ═══════════════════════════════════════════
// COUNTRIES — Shopify's CountryCode enum, human-readable
// ═══════════════════════════════════════════
const COUNTRIES = [
  { code: "AF", name: "Afghanistan" },
  { code: "AL", name: "Albania" },
  { code: "DZ", name: "Algeria" },
  { code: "AD", name: "Andorra" },
  { code: "AO", name: "Angola" },
  { code: "AI", name: "Anguilla" },
  { code: "AG", name: "Antigua & Barbuda" },
  { code: "AR", name: "Argentina" },
  { code: "AM", name: "Armenia" },
  { code: "AW", name: "Aruba" },
  { code: "AC", name: "Ascension Island" },
  { code: "AU", name: "Australia" },
  { code: "AT", name: "Austria" },
  { code: "AZ", name: "Azerbaijan" },
  { code: "BS", name: "Bahamas" },
  { code: "BH", name: "Bahrain" },
  { code: "BD", name: "Bangladesh" },
  { code: "BB", name: "Barbados" },
  { code: "BY", name: "Belarus" },
  { code: "BE", name: "Belgium" },
  { code: "BZ", name: "Belize" },
  { code: "BJ", name: "Benin" },
  { code: "BM", name: "Bermuda" },
  { code: "BT", name: "Bhutan" },
  { code: "BO", name: "Bolivia" },
  { code: "BA", name: "Bosnia & Herzegovina" },
  { code: "BW", name: "Botswana" },
  { code: "BV", name: "Bouvet Island" },
  { code: "BR", name: "Brazil" },
  { code: "IO", name: "British Indian Ocean Territory" },
  { code: "VG", name: "British Virgin Islands" },
  { code: "BN", name: "Brunei" },
  { code: "BG", name: "Bulgaria" },
  { code: "BF", name: "Burkina Faso" },
  { code: "BI", name: "Burundi" },
  { code: "CV", name: "Cabo Verde" },
  { code: "KH", name: "Cambodia" },
  { code: "CM", name: "Cameroon" },
  { code: "CA", name: "Canada" },
  { code: "BQ", name: "Caribbean Netherlands" },
  { code: "KY", name: "Cayman Islands" },
  { code: "CF", name: "Central African Republic" },
  { code: "TD", name: "Chad" },
  { code: "CL", name: "Chile" },
  { code: "CN", name: "China" },
  { code: "CX", name: "Christmas Island" },
  { code: "CC", name: "Cocos (Keeling) Islands" },
  { code: "CO", name: "Colombia" },
  { code: "KM", name: "Comoros" },
  { code: "CG", name: "Congo (Brazzaville)" },
  { code: "CD", name: "Congo (Kinshasa)" },
  { code: "CK", name: "Cook Islands" },
  { code: "CR", name: "Costa Rica" },
  { code: "HR", name: "Croatia" },
  { code: "CU", name: "Cuba" },
  { code: "CW", name: "Cura\u00e7ao" },
  { code: "CY", name: "Cyprus" },
  { code: "CZ", name: "Czechia" },
  { code: "CI", name: "C\u00f4te d'Ivoire" },
  { code: "DK", name: "Denmark" },
  { code: "DJ", name: "Djibouti" },
  { code: "DM", name: "Dominica" },
  { code: "DO", name: "Dominican Republic" },
  { code: "EC", name: "Ecuador" },
  { code: "EG", name: "Egypt" },
  { code: "SV", name: "El Salvador" },
  { code: "GQ", name: "Equatorial Guinea" },
  { code: "ER", name: "Eritrea" },
  { code: "EE", name: "Estonia" },
  { code: "SZ", name: "Eswatini" },
  { code: "ET", name: "Ethiopia" },
  { code: "FK", name: "Falkland Islands" },
  { code: "FO", name: "Faroe Islands" },
  { code: "FJ", name: "Fiji" },
  { code: "FI", name: "Finland" },
  { code: "FR", name: "France" },
  { code: "GF", name: "French Guiana" },
  { code: "PF", name: "French Polynesia" },
  { code: "TF", name: "French Southern Territories" },
  { code: "GA", name: "Gabon" },
  { code: "GM", name: "Gambia" },
  { code: "GE", name: "Georgia" },
  { code: "DE", name: "Germany" },
  { code: "GH", name: "Ghana" },
  { code: "GI", name: "Gibraltar" },
  { code: "GR", name: "Greece" },
  { code: "GL", name: "Greenland" },
  { code: "GD", name: "Grenada" },
  { code: "GP", name: "Guadeloupe" },
  { code: "GT", name: "Guatemala" },
  { code: "GG", name: "Guernsey" },
  { code: "GN", name: "Guinea" },
  { code: "GW", name: "Guinea-Bissau" },
  { code: "GY", name: "Guyana" },
  { code: "HT", name: "Haiti" },
  { code: "HM", name: "Heard & McDonald Is." },
  { code: "HN", name: "Honduras" },
  { code: "HK", name: "Hong Kong SAR" },
  { code: "HU", name: "Hungary" },
  { code: "IS", name: "Iceland" },
  { code: "IN", name: "India" },
  { code: "ID", name: "Indonesia" },
  { code: "IR", name: "Iran" },
  { code: "IQ", name: "Iraq" },
  { code: "IE", name: "Ireland" },
  { code: "IM", name: "Isle of Man" },
  { code: "IL", name: "Israel" },
  { code: "IT", name: "Italy" },
  { code: "JM", name: "Jamaica" },
  { code: "JP", name: "Japan" },
  { code: "JE", name: "Jersey" },
  { code: "JO", name: "Jordan" },
  { code: "KZ", name: "Kazakhstan" },
  { code: "KE", name: "Kenya" },
  { code: "KI", name: "Kiribati" },
  { code: "XK", name: "Kosovo" },
  { code: "KW", name: "Kuwait" },
  { code: "KG", name: "Kyrgyzstan" },
  { code: "LA", name: "Laos" },
  { code: "LV", name: "Latvia" },
  { code: "LB", name: "Lebanon" },
  { code: "LS", name: "Lesotho" },
  { code: "LR", name: "Liberia" },
  { code: "LY", name: "Libya" },
  { code: "LI", name: "Liechtenstein" },
  { code: "LT", name: "Lithuania" },
  { code: "LU", name: "Luxembourg" },
  { code: "MO", name: "Macao SAR" },
  { code: "MG", name: "Madagascar" },
  { code: "MW", name: "Malawi" },
  { code: "MY", name: "Malaysia" },
  { code: "MV", name: "Maldives" },
  { code: "ML", name: "Mali" },
  { code: "MT", name: "Malta" },
  { code: "MQ", name: "Martinique" },
  { code: "MR", name: "Mauritania" },
  { code: "MU", name: "Mauritius" },
  { code: "YT", name: "Mayotte" },
  { code: "MX", name: "Mexico" },
  { code: "MD", name: "Moldova" },
  { code: "MC", name: "Monaco" },
  { code: "MN", name: "Mongolia" },
  { code: "ME", name: "Montenegro" },
  { code: "MS", name: "Montserrat" },
  { code: "MA", name: "Morocco" },
  { code: "MZ", name: "Mozambique" },
  { code: "MM", name: "Myanmar (Burma)" },
  { code: "NA", name: "Namibia" },
  { code: "NR", name: "Nauru" },
  { code: "NP", name: "Nepal" },
  { code: "NL", name: "Netherlands" },
  { code: "AN", name: "Netherlands Antilles" },
  { code: "NC", name: "New Caledonia" },
  { code: "NZ", name: "New Zealand" },
  { code: "NI", name: "Nicaragua" },
  { code: "NE", name: "Niger" },
  { code: "NG", name: "Nigeria" },
  { code: "NU", name: "Niue" },
  { code: "NF", name: "Norfolk Island" },
  { code: "KP", name: "North Korea" },
  { code: "MK", name: "North Macedonia" },
  { code: "NO", name: "Norway" },
  { code: "OM", name: "Oman" },
  { code: "PK", name: "Pakistan" },
  { code: "PS", name: "Palestinian Territories" },
  { code: "PA", name: "Panama" },
  { code: "PG", name: "Papua New Guinea" },
  { code: "PY", name: "Paraguay" },
  { code: "PE", name: "Peru" },
  { code: "PH", name: "Philippines" },
  { code: "PN", name: "Pitcairn" },
  { code: "PL", name: "Poland" },
  { code: "PT", name: "Portugal" },
  { code: "QA", name: "Qatar" },
  { code: "RO", name: "Romania" },
  { code: "RU", name: "Russia" },
  { code: "RW", name: "Rwanda" },
  { code: "RE", name: "R\u00e9union" },
  { code: "WS", name: "Samoa" },
  { code: "SM", name: "San Marino" },
  { code: "SA", name: "Saudi Arabia" },
  { code: "SN", name: "Senegal" },
  { code: "RS", name: "Serbia" },
  { code: "SC", name: "Seychelles" },
  { code: "SL", name: "Sierra Leone" },
  { code: "SG", name: "Singapore" },
  { code: "SX", name: "Sint Maarten" },
  { code: "SK", name: "Slovakia" },
  { code: "SI", name: "Slovenia" },
  { code: "SB", name: "Solomon Islands" },
  { code: "SO", name: "Somalia" },
  { code: "ZA", name: "South Africa" },
  { code: "GS", name: "South Georgia & South Sandwich Is." },
  { code: "KR", name: "South Korea" },
  { code: "SS", name: "South Sudan" },
  { code: "ES", name: "Spain" },
  { code: "LK", name: "Sri Lanka" },
  { code: "BL", name: "St. Barth\u00e9lemy" },
  { code: "SH", name: "St. Helena" },
  { code: "KN", name: "St. Kitts & Nevis" },
  { code: "LC", name: "St. Lucia" },
  { code: "MF", name: "St. Martin" },
  { code: "PM", name: "St. Pierre & Miquelon" },
  { code: "VC", name: "St. Vincent & Grenadines" },
  { code: "SD", name: "Sudan" },
  { code: "SR", name: "Suriname" },
  { code: "SJ", name: "Svalbard & Jan Mayen" },
  { code: "SE", name: "Sweden" },
  { code: "CH", name: "Switzerland" },
  { code: "SY", name: "Syria" },
  { code: "ST", name: "S\u00e3o Tom\u00e9 & Pr\u00edncipe" },
  { code: "TW", name: "Taiwan" },
  { code: "TJ", name: "Tajikistan" },
  { code: "TZ", name: "Tanzania" },
  { code: "TH", name: "Thailand" },
  { code: "TL", name: "Timor-Leste" },
  { code: "TG", name: "Togo" },
  { code: "TK", name: "Tokelau" },
  { code: "TO", name: "Tonga" },
  { code: "TT", name: "Trinidad & Tobago" },
  { code: "TA", name: "Tristan da Cunha" },
  { code: "TN", name: "Tunisia" },
  { code: "TM", name: "Turkmenistan" },
  { code: "TC", name: "Turks & Caicos Islands" },
  { code: "TV", name: "Tuvalu" },
  { code: "TR", name: "T\u00fcrkiye" },
  { code: "UM", name: "U.S. Outlying Islands" },
  { code: "UG", name: "Uganda" },
  { code: "UA", name: "Ukraine" },
  { code: "AE", name: "United Arab Emirates" },
  { code: "GB", name: "United Kingdom" },
  { code: "US", name: "United States" },
  { code: "ZZ", name: "Unknown Region" },
  { code: "UY", name: "Uruguay" },
  { code: "UZ", name: "Uzbekistan" },
  { code: "VU", name: "Vanuatu" },
  { code: "VA", name: "Vatican City" },
  { code: "VE", name: "Venezuela" },
  { code: "VN", name: "Vietnam" },
  { code: "WF", name: "Wallis and Futuna" },
  { code: "EH", name: "Western Sahara" },
  { code: "YE", name: "Yemen" },
  { code: "ZM", name: "Zambia" },
  { code: "ZW", name: "Zimbabwe" },
  { code: "AX", name: "\u00c5land Islands" }
];

// Extra spellings we have actually seen in HubSpot's country picklist and in
// free-text Jotform answers. Keys are lowercased.
const COUNTRY_ALIASES = {
  'usa': 'US',
  'u.s.a.': 'US',
  'u.s.': 'US',
  'us of a': 'US',
  'united states of america': 'US',
  'america': 'US',
  'uk': 'GB',
  'u.k.': 'GB',
  'great britain': 'GB',
  'england': 'GB',
  'england, uk': 'GB',
  'scotland': 'GB',
  'wales': 'GB',
  'northern ireland': 'GB',
  'britain': 'GB',
  'ireland': 'IE',
  'ireland {republic}': 'IE',
  'republic of ireland': 'IE',
  'holland': 'NL',
  'the netherlands': 'NL',
  'south korea': 'KR',
  'korea south': 'KR',
  'republic of korea': 'KR',
  'north korea': 'KP',
  'korea north': 'KP',
  'russia': 'RU',
  'russian federation': 'RU',
  'viet nam': 'VN',
  'uae': 'AE',
  'u.a.e.': 'AE',
  'ivory coast': 'CI',
  "cote d'ivoire": 'CI',
  'cote divoire': 'CI',
  'burma': 'MM',
  'myanmar, (burma)': 'MM',
  'czech republic': 'CZ',
  'swaziland': 'SZ',
  'macedonia': 'MK',
  'bosnia herzegovina': 'BA',
  'antigua & deps': 'AG',
  'burkina': 'BF',
  'cape verde': 'CV',
  'central african rep': 'CF',
  'congo {democratic rep}': 'CD',
  'east timor': 'TL',
  'st kitts & nevis': 'KN',
  'st lucia': 'LC',
  'saint vincent & the grenadines': 'VC',
  'sao tome & principe': 'ST',
  'vatican city': 'VA',
  'hungary': 'HU',
  'magyarország': 'HU',
  'columbia': 'CO',
  'ontario': 'CA',
  'new caledonia': 'NC',
  'bermuda': 'BM',
  'indian': 'IN',
  'puerto rico': 'US',   // Shopify has no PR country code; it is US + province PR
  'american samoa': 'AS',
  'guam': 'GU',
  'us virgin islands': 'VI',
};

const COUNTRY_BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c.name]));
const COUNTRY_BY_NAME = new Map();
for (const c of COUNTRIES) COUNTRY_BY_NAME.set(c.name.toLowerCase(), c.code);

/**
 * Best-effort free text -> ISO 3166-1 alpha-2. Returns '' when we genuinely
 * cannot tell, so the caller shows an empty country picker instead of
 * confidently shipping a shirt to the wrong hemisphere.
 */
function countryCodeFor(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  if (!s) return '';
  // Already a valid code? (HubSpot's picklist contains bare 'us', 'nz', 'au'.)
  const upper = s.toUpperCase();
  if (upper.length === 2 && COUNTRY_BY_CODE.has(upper)) return upper;
  const lower = s.toLowerCase().replace(/\s+/g, ' ').replace(/\.$/, '');
  if (COUNTRY_ALIASES[lower]) return COUNTRY_ALIASES[lower];
  if (COUNTRY_BY_NAME.has(lower)) return COUNTRY_BY_NAME.get(lower);
  // Try again with punctuation stripped ("St. Lucia" vs "St Lucia").
  const depunct = lower.replace(/[.']/g, '');
  for (const [name, code] of COUNTRY_BY_NAME.entries()) {
    if (name.replace(/[.']/g, '') === depunct) return code;
  }
  return '';
}

// ═══════════════════════════════════════════
// PROVINCES / STATES
// ═══════════════════════════════════════════
// Shopify requires provinceCode for countries that have subdivisions it knows
// about. These four cover essentially all of our shipping volume; for anywhere
// else we pass whatever the human typed and let Shopify decide.
const PROVINCES = {
  US: {
    'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR', 'california': 'CA',
    'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE', 'district of columbia': 'DC',
    'washington dc': 'DC', 'washington d.c.': 'DC', 'florida': 'FL', 'georgia': 'GA',
    'hawaii': 'HI', 'idaho': 'ID', 'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA',
    'kansas': 'KS', 'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
    'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
    'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
    'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
    'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
    'oregon': 'OR', 'pennsylvania': 'PA', 'puerto rico': 'PR', 'rhode island': 'RI',
    'south carolina': 'SC', 'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX',
    'utah': 'UT', 'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA',
    'west virginia': 'WV', 'wisconsin': 'WI', 'wyoming': 'WY',
  },
  CA: {
    'alberta': 'AB', 'british columbia': 'BC', 'manitoba': 'MB', 'new brunswick': 'NB',
    'newfoundland and labrador': 'NL', 'newfoundland': 'NL', 'northwest territories': 'NT',
    'nova scotia': 'NS', 'nunavut': 'NU', 'ontario': 'ON', 'prince edward island': 'PE',
    'quebec': 'QC', 'québec': 'QC', 'saskatchewan': 'SK', 'yukon': 'YT',
  },
  AU: {
    'australian capital territory': 'ACT', 'new south wales': 'NSW',
    'northern territory': 'NT', 'queensland': 'QLD', 'south australia': 'SA',
    'tasmania': 'TAS', 'victoria': 'VIC', 'western australia': 'WA',
  },
  NZ: {
    'auckland': 'AUK', 'bay of plenty': 'BOP', 'canterbury': 'CAN', 'gisborne': 'GIS',
    "hawke's bay": 'HKB', 'hawkes bay': 'HKB', 'manawatu-wanganui': 'MWT',
    'marlborough': 'MBH', 'nelson': 'NSN', 'northland': 'NTL', 'otago': 'OTA',
    'southland': 'STL', 'taranaki': 'TKI', 'tasman': 'TAS', 'waikato': 'WKO',
    'wellington': 'WGN', 'west coast': 'WTC',
  },
};

/**
 * Resolve a state/province to the code Shopify wants.
 * Handles the two real-world messes we see: full names ("Connecticut") and
 * codes with the postcode glued on ("CT 06412" — an actual HubSpot value).
 * Returns '' when the country has no subdivision table here, which is correct:
 * Shopify only requires provinceCode where it has provinces.
 */
function provinceCodeFor(countryCode, raw) {
  if (!raw) return '';
  const table = PROVINCES[String(countryCode || '').toUpperCase()];
  let s = String(raw).trim();
  if (!s) return '';
  // "CT 06412" / "PA 15044" -> take the leading alpha token.
  const leading = s.match(/^([A-Za-z]{2,3})\b/);
  const lower = s.toLowerCase().replace(/\s+/g, ' ');

  if (table) {
    if (table[lower]) return table[lower];
    // Already a code?
    const codes = new Set(Object.values(table));
    if (codes.has(s.toUpperCase())) return s.toUpperCase();
    if (leading && codes.has(leading[1].toUpperCase())) return leading[1].toUpperCase();
    // Name with the postcode glued on: "Connecticut 06412"
    const nameOnly = lower.replace(/[\d-]+\s*$/, '').trim();
    if (table[nameOnly]) return table[nameOnly];
    return '';
  }
  // No table for this country — pass through a plausible code, else nothing.
  if (/^[A-Za-z]{2,3}$/.test(s)) return s.toUpperCase();
  return '';
}

// ═══════════════════════════════════════════
// ADDRESS SHAPING
// ═══════════════════════════════════════════
/**
 * Jotform `control_address` answers arrive as an object whose keys vary a
 * little between form builds. Accept every spelling we have seen and return a
 * flat, Shopify-shaped address. Non-object answers (a single free-text line)
 * land in address1 so a human can split them by hand.
 */
function addressFromJotform(answer) {
  const empty = { address1: '', address2: '', city: '', province: '', zip: '', country: '' };
  if (!answer) return empty;

  if (typeof answer === 'string') {
    return Object.assign({}, empty, { address1: answer.trim() });
  }
  if (typeof answer !== 'object' || Array.isArray(answer)) return empty;

  const pick = (...keys) => {
    for (const k of keys) {
      const v = answer[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  };

  return {
    address1: pick('addr_line1', 'address1', 'street', 'line1', 'addr_line_1'),
    address2: pick('addr_line2', 'address2', 'line2', 'addr_line_2'),
    city: pick('city', 'town'),
    province: pick('state', 'province', 'region'),
    zip: pick('postal', 'zip', 'postcode', 'postal_code', 'zipcode'),
    country: pick('country'),
  };
}

/**
 * Guess the country from a state/province name alone.
 *
 * Plenty of applicants leave the country subfield of the address question blank
 * — it is optional on the form, and US students in particular treat it as
 * obvious. But Shopify REQUIRES a countryCode, so a blank there means whoever
 * is ordering has to hunt through a 245-entry dropdown for every such student.
 *
 * A full state name is almost always decisive: "Colorado" appears in exactly
 * one of our province tables. We only return a country when the name matches
 * ONE table — never when it is ambiguous, and never from a bare code like "CO"
 * or "WA" (Washington and Western Australia share WA), because guessing the
 * country wrong silently posts an international shipping label.
 */
function inferCountryFromProvince(raw) {
  const s = String(raw || '').trim().toLowerCase()
    .replace(/\s+/g, ' ').replace(/[\d-]+\s*$/, '').trim();
  if (!s) return '';

  // Full names first: "Colorado" is in exactly one table.
  const byName = [];
  for (const country of Object.keys(PROVINCES)) {
    if (PROVINCES[country][s]) byName.push(country);
  }
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) return '';

  // Then codes. Most are unambiguous across the four tables we keep — "PA" and
  // "NY" are only ever US, "ON" only ever Canada — and US students routinely
  // write the code rather than the name, so refusing all codes would leave the
  // country blank for a large share of them. The genuinely ambiguous ones fall
  // out of this naturally and stay unresolved: WA (US Washington / AU Western
  // Australia), NT (AU Northern Territory / CA Northwest Territories), and
  // TAS (AU Tasmania / NZ Tasman).
  const upper = s.toUpperCase();
  if (!/^[A-Z]{2,3}$/.test(upper)) return '';
  const byCode = [];
  for (const country of Object.keys(PROVINCES)) {
    const codes = new Set(Object.values(PROVINCES[country]));
    if (codes.has(upper)) byCode.push(country);
  }
  return byCode.length === 1 ? byCode[0] : '';
}

/**
 * Turn a loose address into exactly what MailingAddressInput accepts, dropping
 * empty keys (Shopify rejects `provinceCode: ""`). `firstName`/`lastName` are
 * split off the student's display name.
 */
function toShopifyAddress(addr, studentName) {
  const a = addr || {};
  const countryCode = countryCodeFor(a.countryCode || a.country);
  const provinceCode = provinceCodeFor(countryCode, a.provinceCode || a.province || a.state);

  const name = String(studentName || '').trim();
  const bits = name.split(/\s+/).filter(Boolean);
  const firstName = bits.length ? bits[0] : '';
  const lastName = bits.length > 1 ? bits.slice(1).join(' ') : '';

  const out = {};
  const set = (k, v) => { if (v !== undefined && v !== null && String(v).trim() !== '') out[k] = String(v).trim(); };
  set('firstName', firstName);
  set('lastName', lastName);
  set('address1', a.address1);
  set('address2', a.address2);
  set('city', a.city);
  set('zip', a.zip);
  set('phone', a.phone);
  set('countryCode', countryCode);
  set('provinceCode', provinceCode);
  return out;
}

/** One-line rendering for notes and tooltips. */
function formatAddressLine(addr) {
  const a = addr || {};
  const country = a.country || COUNTRY_BY_CODE.get(String(a.countryCode || '').toUpperCase()) || a.countryCode || '';
  return [a.address1, a.address2, a.city, a.province || a.provinceCode, a.zip, country]
    .map((x) => (x === undefined || x === null ? '' : String(x).trim()))
    .filter(Boolean)
    .join(', ');
}

/** Is this address complete enough for Shopify to accept it? */
function addressIsShippable(addr) {
  const a = addr || {};
  const countryCode = countryCodeFor(a.countryCode || a.country);
  if (!countryCode) return false;
  if (!String(a.address1 || '').trim()) return false;
  if (!String(a.city || '').trim()) return false;
  // Countries with a province table need a resolvable province.
  if (PROVINCES[countryCode] && !provinceCodeFor(countryCode, a.provinceCode || a.province)) return false;
  return true;
}

module.exports = {
  SHIRT_SIZES,
  inferCountryFromProvince,
  normalizeShirtSize,
  COUNTRIES,
  countryCodeFor,
  provinceCodeFor,
  addressFromJotform,
  toShopifyAddress,
  formatAddressLine,
  addressIsShippable,
};
