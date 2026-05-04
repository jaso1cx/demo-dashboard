# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.

QoC/NetGauge Handoff:

Two backends are currently implemented (Supabase & Firebase)

Data feeds into the React frontend and renders measurements based on an h3 hex map

QoC calculations happen server side inside each get_points() function for the two repos. Frontend only reads the calculated values.

Supabase DB    Firebase/NetGauge DB
     ↓                  ↓
SupabaseRpcRepo    NetGaugeRepo
        ↘  QoC enrichment  ↙
           CompositeRepo
                 ↓
        GET /api/map/points
                 ↓
   HexMap.jsx → H3 buckets → buildSheetData
                 ↓
            RightPanel

Integral files:

repos/Supabase.py --> SupabaseRpcRepo --> Stores QoC functions
repos/netgauge.py --> NetGaugeRepo --> Duplicates QoC functions but for Firebase
repos/composite.py --> Calls to each active repo

factory.py --> create_repo() --> Finds active repos, scans environment

src/components/HexMap.jsx --> Stores the frontend rendering logic including, map ,fetch, right panel and the h3 hex aggregation 

Since there is no current implementation for each repo to call QoC functions from the same place, when a change is made in one repo it has to be changed in the other as well.

Statuses:

QoC Formulas within backend repos -> ✅

Frontend aggregation and display -> ✅

CSV exporting includes QoC -> ❌

QoC filtering in frontend -> ❌

Next Steps: 

Create QoC columns within the CSV export panel --> exportPanelCsv() + globalExportFilteredCsv()

Add the QoC filtering thresholds with the typePass() filters

If possible, set up QoC calculations with RTT and a TimeWindow that can functionally calculate KPIs over space and time



