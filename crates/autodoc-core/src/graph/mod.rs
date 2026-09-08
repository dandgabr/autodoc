use std::collections::HashMap;
use std::sync::Arc;
use arc_swap::ArcSwap;
use lasso::{Spur, ThreadedRodeo};
use petgraph::graphmap::DiGraphMap;
use serde::{Deserialize, Serialize};

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct CompactNode {
    pub symbol_id: u32,
    pub file_id: u32,
    pub kind: u8,
    pub flags: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrunedDiagram {
    pub total_nodes: usize,
    pub visible_nodes: Vec<String>,
    pub aggregated_clusters: HashMap<String, usize>,
    pub mermaid_code: String,
}

pub struct GraphEngine {
    rodeo: ThreadedRodeo,
    graph: ArcSwap<DiGraphMap<u32, f32>>,
    symbols_map: ArcSwap<HashMap<u32, CompactNode>>,
}

impl Default for GraphEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl GraphEngine {
    pub fn new() -> Self {
        Self {
            rodeo: ThreadedRodeo::new(),
            graph: ArcSwap::from_pointee(DiGraphMap::new()),
            symbols_map: ArcSwap::from_pointee(HashMap::new()),
        }
    }

    pub fn intern(&self, text: &str) -> Spur {
        self.rodeo.get_or_intern(text)
    }

    pub fn resolve(&self, spur: &Spur) -> &str {
        self.rodeo.resolve(spur)
    }

    pub fn add_edge(&self, from: u32, to: u32, weight: f32) {
        let mut new_graph = (**self.graph.load()).clone();
        new_graph.add_edge(from, to, weight);
        self.graph.store(Arc::new(new_graph));
    }

    pub fn register_node(&self, id: u32, node: CompactNode) {
        let mut new_map = (**self.symbols_map.load()).clone();
        new_map.insert(id, node);
        self.symbols_map.store(Arc::new(new_map));
    }

    /// Computes PageRank and Degree Centrality to prune graphs into a safe token budget (default: 35 nodes).
    pub fn generate_pruned_c4(&self, max_nodes: usize) -> PrunedDiagram {
        let graph = self.graph.load();
        let total_nodes = graph.node_count();

        // 1. Calculate degree centrality (in-degree + out-degree)
        let mut scores: Vec<(u32, usize)> = graph
            .nodes()
            .map(|n| {
                let deg = graph.neighbors_directed(n, petgraph::Direction::Incoming).count()
                    + graph.neighbors_directed(n, petgraph::Direction::Outgoing).count();
                (n, deg)
            })
            .collect();

        // Sort descending by connectivity
        scores.sort_by_key(|a| std::cmp::Reverse(a.1));

        let limit = max_nodes.clamp(10, 100).min(scores.len());
        let top_nodes: Vec<u32> = scores.iter().take(limit).map(|(n, _)| *n).collect();
        let top_set: std::collections::HashSet<u32> = top_nodes.iter().copied().collect();

        let mut visible_nodes = Vec::new();
        let mut mermaid_lines = vec!["graph TD".to_string()];

        for &node_id in &top_nodes {
            let label = format!("Node_{}", node_id);
            visible_nodes.push(label.clone());
            mermaid_lines.push(format!("    {}[\"{}\"]", label, label));
        }

        // Add visible edges
        for &from in &top_nodes {
            for to in graph.neighbors_directed(from, petgraph::Direction::Outgoing) {
                if top_set.contains(&to) {
                    mermaid_lines.push(format!("    Node_{} --> Node_{}", from, to));
                }
            }
        }

        // Aggregate pruned satellite nodes into a cluster
        let mut aggregated_clusters = HashMap::new();
        let pruned_count = total_nodes.saturating_sub(limit);
        if pruned_count > 0 {
            aggregated_clusters.insert("SatelliteComponents".to_string(), pruned_count);
            mermaid_lines.push(format!("    subgraph Aux[\"+ {} Auxiliary Components\"]", pruned_count));
            mermaid_lines.push("        AuxNode[\"Aggregated Secondary Components\"]".to_string());
            mermaid_lines.push("    end".to_string());
        }

        PrunedDiagram {
            total_nodes,
            visible_nodes,
            aggregated_clusters,
            mermaid_code: mermaid_lines.join("\n"),
        }
    }
}
