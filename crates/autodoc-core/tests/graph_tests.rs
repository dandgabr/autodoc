use autodoc_core::graph::{CompactNode, GraphEngine};

#[test]
fn test_graph_construction_and_pruning() {
    let engine = GraphEngine::new();

    // Create a dense synthetic graph of 50 nodes
    for i in 1..=50 {
        engine.register_node(
            i,
            CompactNode {
                symbol_id: i,
                file_id: 1,
                kind: 1,
                flags: 0,
            },
        );

        // Highly connected hubs: node 1 and node 2 connect to many nodes
        if i > 2 {
            engine.add_edge(1, i, 1.0);
            engine.add_edge(2, i, 1.0);
        }
    }

    // Request diagram pruned to default 35 nodes
    let pruned = engine.generate_pruned_c4(35);
    assert_eq!(pruned.total_nodes, 50);
    assert_eq!(pruned.visible_nodes.len(), 35);
    assert!(pruned.aggregated_clusters.contains_key("SatelliteComponents"));
    assert_eq!(pruned.aggregated_clusters.get("SatelliteComponents"), Some(&15));

    // Must contain high-degree hubs Node_1 and Node_2
    assert!(pruned.visible_nodes.contains(&"Node_1".to_string()));
    assert!(pruned.visible_nodes.contains(&"Node_2".to_string()));

    // Verify Mermaid syntax generated
    assert!(pruned.mermaid_code.starts_with("graph TD"));
    assert!(pruned.mermaid_code.contains("Aux[\"+ 15 Auxiliary Components\"]"));
}

#[test]
fn test_string_interning() {
    let engine = GraphEngine::new();
    let spur1 = engine.intern("com.example.enterprise.OrderController");
    let spur2 = engine.intern("com.example.enterprise.OrderController");

    // Must resolve to identical interned token
    assert_eq!(spur1, spur2);
    assert_eq!(engine.resolve(&spur1), "com.example.enterprise.OrderController");
}
