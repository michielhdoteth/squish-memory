/**
 * Graph Export Module
 * Generates standalone HTML visualization of the knowledge graph.
 * Part of the existing graph system - no new commands needed.
 * Auto-exports on lifecycle events if graphAutoExport is enabled.
 */

import { getDb } from '../../db/index.js';
import { getDataDir } from '../../config.js';
import { ensureProject } from '../projects.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../logger.js';
import { getMemoryAssociationRows } from '../associations.js';
import { isStrictTrustPolicy } from '../acl/trust-policy.js';
import { denyUnscopedGraphOperation } from './strict-gates.js';

export interface GraphExportResult {
  htmlPath: string;
  jsonPath: string;
  nodeCount: number;
  edgeCount: number;
}

/**
 * Generate a standalone HTML knowledge graph visualization.
 * Writes to <dataDir>/graph/graph.html and <dataDir>/graph/graph.json so no
 * code path ever creates a .squish folder inside the project directory.
 */
export async function exportGraphVisualization(
  projectPath: string = process.cwd()
): Promise<GraphExportResult> {
  if (isStrictTrustPolicy()) {
    await denyUnscopedGraphOperation('export_graph', projectPath);
  }

  const drizzle = await getDb();
  const db: any = (drizzle as any).$client ?? drizzle;
  const project = await ensureProject(projectPath);
  if (!project) throw new Error(`Project not found: ${projectPath}`);

  const outputDir = join(getDataDir(), 'graph');
  await mkdir(outputDir, { recursive: true });

  const nodes: any[] = [];
  const edges: any[] = [];
  const nodeIds = new Set<string>();

  try {
    // Fetch memories
    const memories = db.prepare(`
      SELECT id, content, type, tier, importance_score, created_at
      FROM memories 
      WHERE project_id = ? AND (status IS NULL OR status != 'expired')
      ORDER BY importance_score DESC LIMIT 200
    `).all(project.id) as any[];

    for (const m of memories) {
      if (!nodeIds.has(m.id)) {
        const label = (m.content || '').split('\n')[0]?.substring(0, 60) || 'Untitled';
        nodeIds.add(m.id);
        nodes.push({
          id: m.id, label, type: 'memory', group: m.type || 'note',
          size: Math.min(m.importance_score / 5, 12),
          color: '#4fc3f7',
          importance: m.importance_score || 50,
        });
      }
    }

    // Fetch entities
    try {
      const entities = db.prepare(`SELECT id, name, type FROM entities WHERE project_id = ? LIMIT 100`).all(project.id) as any[];
      for (const e of entities) {
        if (!nodeIds.has(`e:${e.id}`)) {
          nodeIds.add(`e:${e.id}`);
          nodes.push({ id: `e:${e.id}`, label: e.name, type: 'entity', group: e.type || 'concept', size: 1, color: '#81c784', importance: 1 });
        }
      }
    } catch { /* no entities table */ }

    // Read active memory relationships through the temporal association adapter.
    for (const association of await getMemoryAssociationRows()) {
      if (nodeIds.has(association.fromMemoryId) && nodeIds.has(association.toMemoryId)) {
        edges.push({
          source: association.fromMemoryId,
          target: association.toMemoryId,
          label: association.associationType || 'related',
          weight: association.weight || 1,
        });
      }
    }

    // Fetch active canonical entity relations
    try {
      const now = Date.now();
      const rels = db.prepare(`
        SELECT from_id, to_id, edge_type, weight FROM knowledge_edges
        WHERE from_kind = 'entity' AND to_kind = 'entity'
          AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
          AND recorded_at <= ? AND (recorded_to IS NULL OR recorded_to > ?)
      `).all(now, now, now, now) as any[];
      for (const r of rels) {
        if (nodeIds.has(`e:${r.from_id}`) && nodeIds.has(`e:${r.to_id}`)) {
          edges.push({ source: `e:${r.from_id}`, target: `e:${r.to_id}`, label: r.edge_type || 'relates', weight: r.weight || 1 });
        }
      }
    } catch { /* no knowledge_edges table */ }

  } catch (error) {
    logger.error('Graph export failed:', error);
    throw error;
  }

  // Write graph.json
  const jsonPath = join(outputDir, 'graph.json');
  const graphData = { 
    generatedAt: new Date().toISOString(), 
    nodeCount: nodes.length, 
    edgeCount: edges.length,
    nodes, edges 
  };
  await writeFile(jsonPath, JSON.stringify(graphData, null, 2), 'utf-8');

  // Write self-contained HTML with inline D3.js visualization
  const htmlPath = join(outputDir, 'graph.html');
  await writeFile(htmlPath, generateGraphHTML(nodes, edges), 'utf-8');

  logger.info(`Graph exported: ${nodes.length} nodes, ${edges.length} edges to ${htmlPath}`);

  return { htmlPath, jsonPath, nodeCount: nodes.length, edgeCount: edges.length };
}

function generateGraphHTML(nodes: any[], edges: any[]): string {
  const json = JSON.stringify({ nodes, edges });
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Knowledge Graph</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#1a1a2e;color:#e0e0e0;overflow:hidden}
#graph{width:100vw;height:100vh}
#stats{position:fixed;top:12px;left:12px;z-index:100;background:rgba(26,26,46,0.9);padding:8px 14px;border-radius:8px;border:1px solid #333;font-size:12px}
#stats span{color:#4fc3f7;font-weight:bold}
#legend{position:fixed;bottom:12px;right:12px;z-index:100;background:rgba(26,26,46,0.9);padding:8px 12px;border-radius:8px;border:1px solid #333;font-size:11px;display:flex;gap:8px}
.legend-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px}
svg{cursor:grab}svg:active{cursor:grabbing}
.tooltip{position:fixed;padding:6px 10px;background:rgba(0,0,0,0.85);border-radius:5px;font-size:11px;pointer-events:none;z-index:200;border:1px solid #444;display:none;max-width:250px;white-space:nowrap}
</style></head>
<body>
<div id="stats">Knowledge Graph — <span id="counts">0 nodes, 0 edges</span></div>
<div id="legend"><span><span class="legend-dot" style="background:#4fc3f7"></span>Memory</span><span><span class="legend-dot" style="background:#81c784"></span>Entity</span></div>
<div id="graph"></div><div id="tooltip" class="tooltip"></div>
<script src="https://d3js.org/d3.v7.min.js"></script>
<script>
const data = ${json};
const w=window.innerWidth,h=window.innerHeight;
document.getElementById('counts').textContent=data.nodes.length+' nodes, '+data.edges.length+' edges';
const svg=d3.select('#graph').append('svg').attr('width',w).attr('height',h);
const g=svg.append('g');
const tip=d3.select('#tooltip');
svg.call(d3.zoom().scaleExtent([0.1,4]).on('zoom',e=>g.attr('transform',e.transform)));
const sim=d3.forceSimulation(data.nodes).force('link',d3.forceLink(data.edges).id(d=>d.id).distance(70)).force('charge',d3.forceManyBody().strength(-120)).force('center',d3.forceCenter(w/2,h/2)).force('collision',d3.forceCollide().radius(d=>d.size+3));
const link=g.append('g').selectAll('line').data(data.edges).join('line').attr('stroke','#555').attr('stroke-width',d=>Math.max(0.5,d.weight||1)).attr('stroke-opacity',0.35);
const node=g.append('g').selectAll('circle').data(data.nodes).join('circle').attr('r',d=>Math.max(3,d.size)).attr('fill',d=>d.color).attr('stroke','#fff').attr('stroke-width',0.5).attr('opacity',0.85).call(d3.drag().on('start',(e,d)=>{if(!e.active)sim.alphaTarget(0.3).restart();d.fx=d.x;d.fy=d.y}).on('drag',(e,d)=>{d.fx=e.x;d.fy=e.y}).on('end',(e,d)=>{if(!e.active)sim.alphaTarget(0);d.fx=null;d.fy=null}));
g.append('g').selectAll('text').data(data.nodes).join('text').text(d=>d.label).attr('font-size',8).attr('dx',d=>d.size+3).attr('dy',3).attr('fill','#999').attr('pointer-events','none');
node.on('mouseover',(e,d)=>{tip.style('display','block').text(d.label + ' (' + d.type + (d.group ? ' - ' + d.group : '') + ')').style('left',(e.pageX+10)+'px').style('top',(e.pageY+10)+'px');d3.select(e.currentTarget).attr('stroke-width',2)}).on('mousemove',e=>{tip.style('left',(e.pageX+10)+'px').style('top',(e.pageY+10)+'px')}).on('mouseout',e=>{tip.style('display','none');d3.select(e.currentTarget).attr('stroke-width',0.5)});
sim.on('tick',()=>{link.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y).attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);node.attr('cx',d=>d.x).attr('cy',d=>d.y)});
</script></body></html>`;
}
