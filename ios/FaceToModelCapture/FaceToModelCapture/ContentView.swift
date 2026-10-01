import SwiftUI
import Combine

struct ContentView: View {
    @StateObject var tracker = ARFaceTracker()
    @StateObject var streamer = WebSocketStreamer()

    @AppStorage("serverIP") private var serverIP: String = ""
    @AppStorage("serverPort") private var serverPort: String = "8080"

    var body: some View {
        ZStack {
            // Full-screen AR camera feed
            ARSCNViewRepresentable(tracker: tracker)
                .ignoresSafeArea()

            // Bottom overlay panel
            VStack {
                Spacer()

                VStack(spacing: 12) {
                    // Title
                    Text("FaceToModel 🎭")
                        .font(.title2.bold())
                        .foregroundStyle(.white)

                    // Server IP input
                    TextField("IP do servidor (ex: 192.168.1.100)", text: $serverIP)
                        .textFieldStyle(.roundedBorder)
                        .keyboardType(.decimalPad)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)

                    // Port input
                    TextField("Porta", text: $serverPort)
                        .textFieldStyle(.roundedBorder)
                        .keyboardType(.numberPad)

                    // Connect / Disconnect button
                    HStack(spacing: 16) {
                        Button {
                            handleConnect()
                        } label: {
                            Label("Conectar", systemImage: "network")
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 8)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(.green)
                        .disabled(streamer.isConnected || serverIP.isEmpty)

                        Button {
                            streamer.disconnect()
                        } label: {
                            Label("Desconectar", systemImage: "xmark.circle")
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 8)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(.red)
                        .disabled(!streamer.isConnected)
                    }

                    // Status
                    HStack {
                        Circle()
                            .fill(streamer.isConnected ? .green : .red)
                            .frame(width: 10, height: 10)
                        Text(streamer.statusText)
                            .foregroundStyle(.white)
                            .font(.subheadline)
                        Spacer()
                        if streamer.isConnected {
                            Text("\(streamer.fps) fps")
                                .foregroundStyle(.white.opacity(0.8))
                                .font(.caption.monospacedDigit())
                        }
                    }

                    // Instructions when not connected
                    if !streamer.isConnected {
                        Text("Insira o IP e a porta do servidor, depois toque em Conectar.")
                            .font(.caption)
                            .foregroundStyle(.white.opacity(0.7))
                            .multilineTextAlignment(.center)
                    }
                }
                .padding()
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20))
                .padding()
            }
        }
        // Forward blendshapes from tracker to streamer whenever they update
        .onReceive(tracker.$latestBlendShapes) { shapes in
            guard !shapes.isEmpty else { return }
            streamer.send(blendShapes: shapes)
        }
    }

    // MARK: - Helpers

    private func handleConnect() {
        let ip = serverIP.trimmingCharacters(in: .whitespaces)
        let port = serverPort.trimmingCharacters(in: .whitespaces)

        guard !ip.isEmpty,
              let url = URL(string: "ws://\(ip):\(port)?role=iphone") else {
            return
        }
        streamer.connect(url: url)
    }
}

#Preview {
    ContentView()
}
