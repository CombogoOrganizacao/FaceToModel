import Foundation
import Combine

class WebSocketStreamer: NSObject, ObservableObject, URLSessionWebSocketDelegate {
    @Published var statusText: String = "Desconectado"
    @Published var fps: Int = 0
    @Published var isConnected: Bool = false

    private var urlSession: URLSession?
    private var webSocketTask: URLSessionWebSocketTask?
    private var reconnectURL: URL?

    // Serial queue for all WebSocket operations
    private let socketQueue = DispatchQueue(label: "com.facetomodel.websocket", qos: .userInitiated)

    // FPS tracking
    private var frameCounter: Int = 0
    private var fpsTimer: Timer?

    // MARK: - Connection

    func connect(url: URL) {
        reconnectURL = url
        socketQueue.async { [weak self] in
            guard let self else { return }
            self._connect(url: url)
        }
    }

    private func _connect(url: URL) {
        let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        let task = session.webSocketTask(with: url)
        urlSession = session
        webSocketTask = task
        task.resume()

        DispatchQueue.main.async {
            self.statusText = "Conectando…"
        }
    }

    func disconnect() {
        reconnectURL = nil   // prevent auto-reconnect
        socketQueue.async { [weak self] in
            self?.webSocketTask?.cancel(with: .goingAway, reason: nil)
            self?.webSocketTask = nil
            self?.urlSession = nil
        }
        DispatchQueue.main.async {
            self.isConnected = false
            self.statusText = "Desconectado"
            self.stopFPSTimer()
        }
    }

    // MARK: - Sending

    func send(blendShapes: [String: Float]) {
        guard isConnected, let task = webSocketTask else { return }

        let payload: [String: Any] = [
            "blendShapes": blendShapes,
            "timestamp": Date().timeIntervalSince1970
        ]

        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }

        socketQueue.async { [weak self] in
            guard let self else { return }
            task.send(.data(data)) { [weak self] error in
                if let error {
                    print("WebSocket send error: \(error.localizedDescription)")
                    self?.handleSendError()
                } else {
                    // Increment FPS counter on success (thread-safe via atomic increment)
                    DispatchQueue.main.async {
                        self?.frameCounter += 1
                    }
                }
            }
        }
    }

    private func handleSendError() {
        DispatchQueue.main.async {
            self.isConnected = false
            self.statusText = "Erro – reconectando…"
        }

        guard let url = reconnectURL else { return }

        // Attempt reconnect after 2 seconds
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, self.reconnectURL != nil else { return }
            self.socketQueue.async {
                self._connect(url: url)
            }
        }
    }

    // MARK: - FPS Timer

    private func startFPSTimer() {
        stopFPSTimer()
        fpsTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.fps = self.frameCounter
            self.frameCounter = 0
        }
    }

    private func stopFPSTimer() {
        fpsTimer?.invalidate()
        fpsTimer = nil
        fps = 0
        frameCounter = 0
    }

    // MARK: - URLSessionWebSocketDelegate

    func urlSession(_ session: URLSession,
                    webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol protocol: String?) {
        DispatchQueue.main.async {
            self.isConnected = true
            self.statusText = "Conectado ✓"
            self.startFPSTimer()
        }
    }

    func urlSession(_ session: URLSession,
                    webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
                    reason: Data?) {
        DispatchQueue.main.async {
            self.isConnected = false
            self.statusText = "Desconectado"
            self.stopFPSTimer()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error else { return }
        print("URLSession task error: \(error.localizedDescription)")
        DispatchQueue.main.async {
            self.isConnected = false
            self.statusText = "Erro de conexão"
            self.stopFPSTimer()
        }

        guard let url = reconnectURL else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, self.reconnectURL != nil else { return }
            self.socketQueue.async {
                self._connect(url: url)
            }
        }
    }
}
