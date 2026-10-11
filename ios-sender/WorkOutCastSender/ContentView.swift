import SwiftUI

struct ContentView: View {
    @StateObject private var sender = HeartRateSender()
    @State private var name = Config.studentName
    @State private var server = Config.serverURL.absoluteString

    var body: some View {
        NavigationStack {
            Form {
                Section("Profilo") {
                    TextField("Nome", text: $name)
                    TextField("Server coach", text: $server)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                }
                Section("Battito") {
                    Text("\(sender.bpm > 0 ? sender.bpm : "--") BPM")
                        .font(.largeTitle.bold())
                    Text(sender.status).foregroundStyle(.secondary)
                }
                Section {
                    if sender.isRunning {
                        Button("Stop", role: .destructive) {
                            UserDefaults.standard.set(server, forKey: "coachServerURL")
                            Task { await sender.stop() }
                        }
                    } else {
                        Button("Start — invia al coach") {
                            UserDefaults.standard.set(server, forKey: "coachServerURL")
                            Task { await sender.start(name: name) }
                        }
                    }
                }
            }
            .navigationTitle("HRcast")
        }
    }
}
