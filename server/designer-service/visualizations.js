"use strict";
/**
 * Katalog visual — PRD 6.5 (minimal 80 jenis) & Lampiran A.
 *
 * Setiap entri menyatakan kapabilitas interaktifnya (drill-down, cross-filter, tooltip)
 * agar Dashboard Designer dapat memvalidasi konfigurasi widget sebelum dipublikasikan,
 * bukan menemukan ketidakcocokan saat pengguna melihat dashboard.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.VISUALIZATION_COUNT = exports.VISUALIZATION_CATALOG = void 0;
exports.visualsByFamily = visualsByFamily;
exports.findVisual = findVisual;
function v(code, label, family, minMeasures = 1, minDimensions = 1, supportsDrillDown = true, supportsCrossFilter = true) {
    return { code, label, family, minMeasures, minDimensions, supportsDrillDown, supportsCrossFilter };
}
/**
 * Katalog lengkap. Semua visual mendukung tooltip kontekstual (PRD 6.5) — karena itu
 * tooltip tidak dijadikan flag per entri, melainkan jaminan tingkat komponen.
 */
exports.VISUALIZATION_CATALOG = [
    // --- Trend ---
    v('line', 'Line', 'trend'),
    v('multi_line', 'Multi Line', 'trend', 2),
    v('area', 'Area', 'trend'),
    v('stacked_area', 'Stacked Area', 'trend'),
    v('stream', 'Stream Graph', 'trend'),
    v('spline', 'Spline', 'trend'),
    v('step_line', 'Step Line', 'trend'),
    v('sparkline', 'Sparkline', 'trend', 1, 1, false, false),
    v('candlestick', 'Candlestick', 'trend', 4),
    v('ohlc', 'OHLC', 'trend', 4),
    v('range_area', 'Range Area', 'trend', 2),
    v('slope', 'Slope Chart', 'trend'),
    v('control_chart', 'Control Chart', 'trend'),
    v('run_chart', 'Run Chart', 'trend'),
    // --- Comparison ---
    v('bar', 'Bar', 'comparison'),
    v('column', 'Column', 'comparison'),
    v('grouped_bar', 'Grouped Bar', 'comparison', 2),
    v('stacked_bar', 'Stacked Bar', 'comparison'),
    v('percent_stacked_bar', '100% Stacked Bar', 'comparison'),
    v('bullet', 'Bullet Chart', 'comparison', 2, 1),
    v('lollipop', 'Lollipop', 'comparison'),
    v('dot_plot', 'Dot Plot', 'comparison'),
    v('dumbbell', 'Dumbbell', 'comparison', 2),
    v('diverging_bar', 'Diverging Bar', 'comparison'),
    v('radial_bar', 'Radial Bar', 'comparison'),
    v('pyramid', 'Population Pyramid', 'comparison', 2),
    v('pareto', 'Pareto', 'comparison'),
    v('waterfall', 'Waterfall', 'comparison'),
    v('nightingale', 'Nightingale Rose', 'comparison'),
    v('bar_race', 'Bar Race', 'comparison'),
    // --- Composition ---
    v('pie', 'Pie', 'composition'),
    v('donut', 'Donut', 'composition'),
    v('semi_donut', 'Semi Donut', 'composition'),
    v('treemap', 'Treemap', 'composition'),
    v('sunburst', 'Sunburst', 'composition'),
    v('icicle', 'Icicle', 'composition'),
    v('marimekko', 'Marimekko', 'composition'),
    v('funnel', 'Funnel', 'composition'),
    v('pictogram', 'Pictogram', 'composition'),
    v('waffle', 'Waffle', 'composition'),
    v('venn', 'Venn Diagram', 'composition'),
    v('upset', 'UpSet Plot', 'composition'),
    // --- Distribution ---
    v('histogram', 'Histogram', 'distribution', 1, 0),
    v('box_plot', 'Box Plot', 'distribution'),
    v('violin', 'Violin Plot', 'distribution'),
    v('beeswarm', 'Beeswarm', 'distribution'),
    v('density', 'Density Plot', 'distribution', 1, 0),
    v('ridgeline', 'Ridgeline', 'distribution'),
    v('qq_plot', 'Q-Q Plot', 'distribution', 1, 0, false),
    v('ecdf', 'ECDF', 'distribution', 1, 0),
    v('strip_plot', 'Strip Plot', 'distribution'),
    v('error_bar', 'Error Bar', 'distribution', 2),
    // --- Relationship ---
    v('scatter', 'Scatter', 'relationship', 2, 0),
    v('bubble', 'Bubble', 'relationship', 3, 0),
    v('connected_scatter', 'Connected Scatter', 'relationship', 2),
    v('hexbin', 'Hexbin', 'relationship', 2, 0),
    v('heatmap', 'Heatmap', 'relationship', 1, 2),
    v('correlation_matrix', 'Correlation Matrix', 'relationship', 2, 0, false),
    v('parallel_coordinates', 'Parallel Coordinates', 'relationship', 3, 0),
    v('radar', 'Radar', 'relationship', 1, 1),
    v('network', 'Network Graph', 'relationship', 1, 2),
    v('chord', 'Chord Diagram', 'relationship', 1, 2),
    v('arc_diagram', 'Arc Diagram', 'relationship', 1, 2),
    v('regression_plot', 'Regression Plot', 'relationship', 2, 0),
    // --- Hierarchy ---
    v('tree', 'Tree', 'hierarchy'),
    v('dendrogram', 'Dendrogram', 'hierarchy'),
    v('org_chart', 'Org Chart', 'hierarchy'),
    v('circle_packing', 'Circle Packing', 'hierarchy'),
    v('decomposition_tree', 'Decomposition Tree', 'hierarchy'),
    // --- Flow ---
    v('sankey', 'Sankey', 'flow', 1, 2),
    v('alluvial', 'Alluvial', 'flow', 1, 2),
    v('flow_map', 'Flow Map', 'flow', 1, 2),
    v('process_flow', 'Process Flow', 'flow', 1, 2),
    v('journey_map', 'Journey Map', 'flow', 1, 2),
    // --- Geospatial (PRD 6.5: minimal titik, choropleth, density) ---
    v('geo_point', 'Geo Point Map', 'geospatial'),
    v('choropleth', 'Choropleth Map', 'geospatial'),
    v('density_map', 'Density Map', 'geospatial'),
    v('cluster_map', 'Cluster Map', 'geospatial'),
    v('bubble_map', 'Bubble Map', 'geospatial', 2),
    v('route_map', 'Route Map', 'geospatial'),
    v('isoline_map', 'Isoline Map', 'geospatial'),
    // --- Schedule ---
    v('gantt', 'Gantt', 'schedule', 2, 1),
    v('timeline', 'Timeline', 'schedule', 1, 1),
    v('calendar_heatmap', 'Calendar Heatmap', 'schedule'),
    v('milestone', 'Milestone Chart', 'schedule'),
    v('resource_schedule', 'Resource Schedule', 'schedule', 2, 1),
    // --- KPI ---
    v('threshold_ring', 'Threshold Ring', 'kpi', 1, 0, false, false),
    v('gauge', 'Gauge', 'kpi', 1, 0, false, false),
    v('kpi_card', 'KPI Card', 'kpi', 1, 0, false, false),
    v('trend_indicator', 'Trend Indicator', 'kpi', 1, 0, false, false),
    v('progress_bar', 'Progress Bar', 'kpi', 1, 0, false, false),
    v('scorecard_tile', 'Scorecard Tile', 'kpi', 1, 0, false, false),
    // --- Table ---
    v('table', 'Table', 'table', 0, 1),
    v('pivot', 'Pivot Table', 'table', 1, 2),
    v('matrix', 'Matrix', 'table', 1, 2),
    v('data_grid', 'Data Grid', 'table', 0, 1),
    v('summary_table', 'Summary Table', 'table', 1, 1),
];
/** PRD 6.5 mensyaratkan katalog minimal 80 jenis visual. */
exports.VISUALIZATION_COUNT = exports.VISUALIZATION_CATALOG.length;
function visualsByFamily() {
    const out = new Map();
    for (const visual of exports.VISUALIZATION_CATALOG) {
        if (!out.has(visual.family))
            out.set(visual.family, []);
        out.get(visual.family).push(visual);
    }
    return out;
}
function findVisual(code) {
    return exports.VISUALIZATION_CATALOG.find((v2) => v2.code === code);
}
//# sourceMappingURL=visualizations.js.map