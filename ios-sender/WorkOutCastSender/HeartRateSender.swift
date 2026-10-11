import Foundation
import HealthKit

@MainActor
final class HeartRateSender: ObservableObject {
    @Published var bpm: Int = 0
    @Published var isRunning = false
    @Published var status = "Pronto"

    private let healthStore = HKHealthStore()
    private var workoutSession: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?

    func requestAuthorization() async throws {
        guard HKHealthStore.isHealthDataAvailable() else {
            throw NSError(domain: "HRcast", code: 1, userInfo: [NSLocalizedDescriptionKey: "HealthKit non disponibile"])
        }
        let types: Set = [
            HKObjectType.workoutType(),
            HKObjectType.quantityType(forIdentifier: .heartRate)!
        ]
        try await healthStore.requestAuthorization(toShare: types, read: types)
    }

    func start(name: String) async {
        Config.studentName = name
        status = "Avvio allenamento…"
        do {
            try await requestAuthorization()
            let config = HKWorkoutConfiguration()
            config.activityType = .cycling
            config.locationType = .indoor

            let session = try HKWorkoutSession(healthStore: healthStore, configuration: config)
            let liveBuilder = session.associatedWorkoutBuilder()
            liveBuilder.dataSource = HKLiveWorkoutDataSource(healthStore: healthStore, workoutConfiguration: config)

            session.delegate = SessionDelegate(sender: self)
            liveBuilder.delegate = BuilderDelegate(sender: self)

            workoutSession = session
            builder = liveBuilder

            let start = Date()
            session.startActivity(with: start)
            try await liveBuilder.beginCollection(at: start)

            isRunning = true
            status = "In invio a \(Config.serverURL.host ?? "coach")…"
        } catch {
            status = "Errore: \(error.localizedDescription)"
        }
    }

    func stop() async {
        status = "Stop…"
        workoutSession?.stopActivity(with: Date())
        if let builder = builder {
            try? await builder.endCollection(at: Date())
            try? await builder.finishWorkout()
        }
        workoutSession = nil
        builder = nil
        isRunning = false
        status = "Fermato"
    }

    func send(bpm: Int) {
        guard bpm > 0 else { return }
        self.bpm = bpm
        Task {
            var req = URLRequest(url: Config.serverURL.appendingPathComponent("api/bpm"))
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let body: [String: Any] = [
                "studentId": Config.studentId,
                "name": Config.studentName,
                "bpm": bpm,
                "source": "ios-app"
            ]
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
            _ = try? await URLSession.shared.data(for: req)
        }
    }
}

private final class SessionDelegate: NSObject, HKWorkoutSessionDelegate {
    weak var sender: HeartRateSender?
    init(sender: HeartRateSender) { self.sender = sender }
    func workoutSession(_ workoutSession: HKWorkoutSession, didChangeTo toState: HKWorkoutSessionState, from fromState: HKWorkoutSessionState, date: Date) {}
    func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
        Task { @MainActor in sender?.status = error.localizedDescription }
    }
}

private final class BuilderDelegate: NSObject, HKLiveWorkoutBuilderDelegate {
    weak var sender: HeartRateSender?
    init(sender: HeartRateSender) { self.sender = sender }

    func workoutBuilder(_ workoutBuilder: HKLiveWorkoutBuilder, didCollectDataOf collectedTypes: Set<HKSampleType>) {
        guard let hrType = HKObjectType.quantityType(forIdentifier: .heartRate),
              collectedTypes.contains(hrType),
              let stats = workoutBuilder.statistics(for: hrType),
              let qty = stats.mostRecentQuantity() else { return }
        let unit = HKUnit.count().unitDivided(by: .minute())
        let value = Int(qty.doubleValue(for: unit))
        Task { @MainActor in sender?.send(bpm: value) }
    }

    func workoutBuilderDidCollectEvent(_ workoutBuilder: HKLiveWorkoutBuilder) {}
}
