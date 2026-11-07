import { describe, it, expect } from 'bun:test';
import { createGraphView, getSemanticView, getTemporalView, getCausalView, getEntityView } from '../../core/knowledge/graph-views.js';
import type { GraphViewConfig, GraphViewResult, GraphViewType } from '../../core/knowledge/graph-views.js';

describe('graph-views', () => {
  it('creates a semantic view config', () => {
    const config = createGraphView('semantic');
    expect(config.viewType).toBe('semantic');
    expect(config.edgeTypes).toContain('related_to');
    expect(config.edgeTypes).toContain('supports');
    expect(config.edgeTypes).not.toContain('causes');
  });

  it('creates a temporal view config', () => {
    const config = createGraphView('temporal');
    expect(config.viewType).toBe('temporal');
    expect(config.orderBy).toBe('created_at');
  });

  it('creates a causal view config', () => {
    const config = createGraphView('causal');
    expect(config.viewType).toBe('causal');
    expect(config.edgeTypes).toContain('causes');
    expect(config.edgeTypes).toContain('informed_by');
    expect(config.edgeTypes).toContain('sourced_from');
  });

  it('creates an entity view config', () => {
    const config = createGraphView('entity');
    expect(config.viewType).toBe('entity');
    expect(config.edgeTypes).toContain('references');
    expect(config.edgeTypes).toContain('about');
    expect(config.edgeTypes).toContain('describes');
  });

  it('getSemanticView returns a semantic config', () => {
    const config = getSemanticView();
    expect(config.viewType).toBe('semantic');
    expect(config.edgeTypes).toContain('related_to');
    expect(config.edgeTypes).toContain('supports');
    expect(config.edgeTypes).toContain('extends');
    expect(config.edgeTypes).toContain('informed_by');
    expect(config.edgeTypes).toContain('contradicts');
    expect(config.edgeTypes).toContain('rejects');
  });

  it('getTemporalView returns a temporal config', () => {
    const config = getTemporalView();
    expect(config.viewType).toBe('temporal');
    expect(config.orderBy).toBe('created_at');
    expect(config.edgeTypes).toContain('supersedes');
    expect(config.edgeTypes).toContain('updates');
    expect(config.edgeTypes).toContain('informed_by');
    expect(config.edgeTypes).toContain('sourced_from');
  });

  it('getCausalView returns a causal config', () => {
    const config = getCausalView();
    expect(config.viewType).toBe('causal');
    expect(config.edgeTypes).toContain('causes');
    expect(config.edgeTypes).toContain('informed_by');
    expect(config.edgeTypes).toContain('sourced_from');
  });

  it('getEntityView returns an entity config', () => {
    const config = getEntityView();
    expect(config.viewType).toBe('entity');
    expect(config.edgeTypes).toContain('references');
    expect(config.edgeTypes).toContain('about');
    expect(config.edgeTypes).toContain('describes');
    expect(config.edgeTypes).toContain('created_by');
    expect(config.edgeTypes).toContain('affects');
  });

  it('all view configs have required fields', () => {
    const viewTypes: GraphViewType[] = ['semantic', 'temporal', 'causal', 'entity'];
    for (const vt of viewTypes) {
      const config = createGraphView(vt);
      expect(config.viewType).toBe(vt);
      expect(Array.isArray(config.edgeTypes)).toBe(true);
      expect(config.edgeTypes.length).toBeGreaterThan(0);
      expect(config.orderBy).toBeDefined();
      expect(config.maxDepth).toBeGreaterThan(0);
      expect(config.minWeight).toBeGreaterThanOrEqual(0);
    }
  });

  it('semantic view has maxDepth of 3', () => {
    const config = createGraphView('semantic');
    expect(config.maxDepth).toBe(3);
  });

  it('temporal view has maxDepth of 5', () => {
    const config = createGraphView('temporal');
    expect(config.maxDepth).toBe(5);
  });

  it('causal view has maxDepth of 4', () => {
    const config = createGraphView('causal');
    expect(config.maxDepth).toBe(4);
  });

  it('entity view has maxDepth of 2', () => {
    const config = createGraphView('entity');
    expect(config.maxDepth).toBe(2);
  });
});
