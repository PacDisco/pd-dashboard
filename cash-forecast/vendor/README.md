# Vendored PDF libraries

Used only by `../report-pdf.js`, loaded on the first "Export PDF" click.

| File | Package | Version | Licence |
|---|---|---|---|
| `jspdf.umd.min.js` | [jspdf](https://www.npmjs.com/package/jspdf) | 4.2.1 | MIT |
| `jspdf.plugin.autotable.mjs` | [jspdf-autotable](https://www.npmjs.com/package/jspdf-autotable) | 5.0.8 | MIT |

Vendored rather than loaded from a CDN because this page carries bank balances.
To upgrade: `npm pack` the new versions, copy the same two files from `dist/`,
update this table, and run `node test/cash-report.test.mjs` and
`node test/cash-report-pdf.smoke.mjs`.
