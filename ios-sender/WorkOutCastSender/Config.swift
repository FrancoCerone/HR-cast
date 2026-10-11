import Foundation

enum Config {
    /// IP del PC coach sulla rete palestra (es. http://192.168.1.10:3033)
    static var serverURL: URL {
        let saved = UserDefaults.standard.string(forKey: "coachServerURL")
        let raw = saved ?? "http://192.168.1.10:3033"
        return URL(string: raw) ?? URL(string: "http://192.168.1.10:3033")!
    }

    static var studentId: String {
        if let id = UserDefaults.standard.string(forKey: "studentId") { return id }
        let id = "s-" + UUID().uuidString.prefix(8).lowercased()
        UserDefaults.standard.set(String(id), forKey: "studentId")
        return String(id)
    }

    static var studentName: String {
        get { UserDefaults.standard.string(forKey: "studentName") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "studentName") }
    }
}
