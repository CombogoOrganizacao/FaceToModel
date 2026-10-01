import SwiftUI
import ARKit
import SceneKit

struct ARSCNViewRepresentable: UIViewRepresentable {
    let tracker: ARFaceTracker

    func makeUIView(context: Context) -> ARSCNView {
        let sceneView = ARSCNView()
        sceneView.automaticallyUpdatesLighting = true
        sceneView.autoenablesDefaultLighting = true

        // Show statistics overlay (optional, useful during development)
        // sceneView.showsStatistics = true

        // Set the scene view delegate so face mesh is rendered
        sceneView.delegate = context.coordinator

        // Use the tracker's session
        let config = ARFaceTrackingConfiguration()
        config.isWorldTrackingEnabled = false

        tracker.session.run(config, options: [.resetTracking, .removeExistingAnchors])
        sceneView.session = tracker.session

        return sceneView
    }

    func updateUIView(_ uiView: ARSCNView, context: Context) {
        // No live updates needed; session is driven by tracker
    }

    static func dismantleUIView(_ uiView: ARSCNView, coordinator: Coordinator) {
        uiView.session.pause()
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    // MARK: - Coordinator (ARSCNViewDelegate)

    class Coordinator: NSObject, ARSCNViewDelegate {
        /// Called when an ARAnchor is added – create a wireframe face node
        func renderer(_ renderer: SCNSceneRenderer, nodeFor anchor: ARAnchor) -> SCNNode? {
            guard anchor is ARFaceAnchor else { return nil }

            // ARSCNFaceGeometry renders the face mesh automatically
            guard let device = MTLCreateSystemDefaultDevice(),
                  let faceGeometry = ARSCNFaceGeometry(device: device) else {
                return SCNNode()
            }

            let material = faceGeometry.firstMaterial!
            material.diffuse.contents = UIColor.systemGreen.withAlphaComponent(0.3)
            material.fillMode = .lines
            material.isDoubleSided = true

            let node = SCNNode(geometry: faceGeometry)
            return node
        }

        /// Called every frame – update the face mesh geometry
        func renderer(_ renderer: SCNSceneRenderer,
                      didUpdate node: SCNNode,
                      for anchor: ARAnchor) {
            guard let faceAnchor = anchor as? ARFaceAnchor,
                  let faceGeometry = node.geometry as? ARSCNFaceGeometry else { return }
            faceGeometry.update(from: faceAnchor.geometry)
        }
    }
}
