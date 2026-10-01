import ARKit
import Combine

class ARFaceTracker: NSObject, ObservableObject, ARSessionDelegate {
    @Published var latestBlendShapes: [String: Float] = [:]
    @Published var isTracking: Bool = false

    var session: ARSession = ARSession()
    private var frameCount = 0

    override init() {
        super.init()
        session.delegate = self
    }

    // MARK: - ARSessionDelegate

    func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
        frameCount += 1
        // Throttle: send every 2nd frame (~30 fps)
        guard frameCount % 2 == 0 else { return }
        guard let face = anchors.first(where: { $0 is ARFaceAnchor }) as? ARFaceAnchor else { return }

        let shapes = face.blendShapes.reduce(into: [String: Float]()) {
            $0[$1.key.rawValue] = $1.value.floatValue
        }

        DispatchQueue.main.async {
            self.latestBlendShapes = shapes
            self.isTracking = true
        }
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        DispatchQueue.main.async {
            self.isTracking = false
        }
    }

    func sessionWasInterrupted(_ session: ARSession) {
        DispatchQueue.main.async {
            self.isTracking = false
        }
    }

    func sessionInterruptionEnded(_ session: ARSession) {
        // Restart tracking after interruption
        let config = ARFaceTrackingConfiguration()
        config.isWorldTrackingEnabled = false
        session.run(config, options: [.resetTracking])
    }
}
