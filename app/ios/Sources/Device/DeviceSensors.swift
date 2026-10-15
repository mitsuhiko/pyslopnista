import CoreLocation
import CoreMotion
import MapKit
import UIKit

/// Location, motion and haptics for the device modules (D40).
@MainActor
final class DeviceSensors: NSObject, CLLocationManagerDelegate {
    private lazy var locationManager: CLLocationManager = {
        let m = CLLocationManager()
        m.delegate = self
        m.desiredAccuracy = kCLLocationAccuracyBest
        return m
    }()
    private var authorizationWaiters: [CheckedContinuation<Void, Never>] = []
    private var lastLocation: CLLocation?
    private var updating = false
    private let motion = CMMotionManager()

    func perform(_ op: String, _ v: [String: Any]) async throws -> Any? {
        switch op {
        case "location.start":
            try await authorizeLocation()
            updating = true
            locationManager.startUpdatingLocation()
            return nil
        case "location.stop":
            updating = false
            locationManager.stopUpdatingLocation()
            return nil
        case "location.get":
            // The first fix can take a moment after start_updates().
            for _ in 0..<50 where lastLocation == nil && updating { try? await Task.sleep(for: .milliseconds(100)) }
            return (lastLocation ?? locationManager.location).map(Self.info) ?? NSNull()
        case "location.authorized":
            let s = locationManager.authorizationStatus
            return s == .authorizedWhenInUse || s == .authorizedAlways
        case "location.geocode":
            let marks = (try? await CLGeocoder().geocodeAddressString(v.string("address") ?? "")) ?? []
            return marks.compactMap { $0.location }.map { ["latitude": $0.coordinate.latitude, "longitude": $0.coordinate.longitude] }
        case "location.reverseGeocode":
            let loc = CLLocation(latitude: v.double("latitude") ?? 0, longitude: v.double("longitude") ?? 0)
            let marks = (try? await CLGeocoder().reverseGeocodeLocation(loc)) ?? []
            return marks.map(Self.address)
        case "location.snapshot": return try await snapshot(v)
        case "motion.start":
            if motion.isDeviceMotionAvailable, !motion.isDeviceMotionActive {
                motion.deviceMotionUpdateInterval = 1.0 / 60
                let frames = CMMotionManager.availableAttitudeReferenceFrames()
                motion.startDeviceMotionUpdates(using: frames.contains(.xArbitraryCorrectedZVertical) ? .xArbitraryCorrectedZVertical : .xArbitraryZVertical)
            }
            return nil
        case "motion.stop":
            motion.stopDeviceMotionUpdates()
            return nil
        case "motion.read":
            guard let m = motion.deviceMotion else { return [:] }
            return [
                "gravity": [m.gravity.x, m.gravity.y, m.gravity.z],
                "user_acceleration": [m.userAcceleration.x, m.userAcceleration.y, m.userAcceleration.z],
                "attitude": [m.attitude.roll, m.attitude.pitch, m.attitude.yaw],
                "magnetic_field": [m.magneticField.field.x, m.magneticField.field.y, m.magneticField.field.z, Double(m.magneticField.accuracy.rawValue)],
            ]
        case "haptics":
            switch v.string("kind") {
            case "notification":
                let type: UINotificationFeedbackGenerator.FeedbackType = v.string("style") == "error" ? .error : v.string("style") == "warning" ? .warning : .success
                UINotificationFeedbackGenerator().notificationOccurred(type)
            case "selection":
                UISelectionFeedbackGenerator().selectionChanged()
            default:
                let style: UIImpactFeedbackGenerator.FeedbackStyle = switch v.string("style") {
                case "light": .light
                case "heavy": .heavy
                case "soft": .soft
                case "rigid": .rigid
                default: .medium
                }
                UIImpactFeedbackGenerator(style: style).impactOccurred(intensity: max(0, min(1, v.double("intensity") ?? 1)))
            }
            return nil
        default:
            throw DeviceBridge.Failure(kind: "NotImplementedError", message: "device.\(op)")
        }
    }

    /// The next program starts without the last one's sensors.
    func reset() {
        if updating { locationManager.stopUpdatingLocation() }
        updating = false
        motion.stopDeviceMotionUpdates()
    }

    // MARK: location

    private func authorizeLocation() async throws {
        if locationManager.authorizationStatus == .notDetermined {
            await withCheckedContinuation { c in
                authorizationWaiters.append(c)
                locationManager.requestWhenInUseAuthorization()
            }
        }
        let s = locationManager.authorizationStatus
        guard s == .authorizedWhenInUse || s == .authorizedAlways else { throw DeviceBridge.Failure.permission("Access to the location") }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        MainActor.assumeIsolated {
            guard status != .notDetermined else { return }
            let waiters = authorizationWaiters
            authorizationWaiters = []
            for w in waiters { w.resume() }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        MainActor.assumeIsolated { if let last = locations.last { lastLocation = last } }
    }

    private static func info(_ l: CLLocation) -> [String: Any] {
        [
            "latitude": l.coordinate.latitude, "longitude": l.coordinate.longitude, "altitude": l.altitude,
            "timestamp": l.timestamp.timeIntervalSince1970, "horizontal_accuracy": l.horizontalAccuracy,
            "vertical_accuracy": l.verticalAccuracy, "speed": l.speed, "course": l.course,
        ]
    }

    private static func address(_ p: CLPlacemark) -> [String: Any] {
        var out: [String: Any] = [:]
        let street = [p.subThoroughfare, p.thoroughfare].compactMap { $0 }.joined(separator: " ")
        let values: [(String, String?)] = [
            ("Name", p.name), ("Street", street.isEmpty ? nil : street), ("Thoroughfare", p.thoroughfare),
            ("SubThoroughfare", p.subThoroughfare), ("City", p.locality), ("SubLocality", p.subLocality),
            ("State", p.administrativeArea), ("SubAdministrativeArea", p.subAdministrativeArea), ("ZIP", p.postalCode),
            ("Country", p.country), ("CountryCode", p.isoCountryCode),
        ]
        for (k, value) in values { if let value { out[k] = value } }
        if let loc = p.location { out["latitude"] = loc.coordinate.latitude; out["longitude"] = loc.coordinate.longitude }
        return out
    }

    private func snapshot(_ v: [String: Any]) async throws -> Any? {
        let options = MKMapSnapshotter.Options()
        let center = CLLocationCoordinate2D(latitude: v.double("latitude") ?? 0, longitude: v.double("longitude") ?? 0)
        options.region = MKCoordinateRegion(center: center, latitudinalMeters: v.double("height") ?? 1000, longitudinalMeters: v.double("width") ?? 1000)
        options.size = CGSize(width: v.double("img_width") ?? 240, height: v.double("img_height") ?? 240)
        let scale = v.double("img_scale") ?? 0
        options.traitCollection = UITraitCollection(displayScale: scale > 0 ? scale : 2)
        switch v.string("map_type") {
        case "satellite": options.preferredConfiguration = MKImageryMapConfiguration()
        case "hybrid": options.preferredConfiguration = MKHybridMapConfiguration()
        default:
            let config = MKStandardMapConfiguration()
            config.pointOfInterestFilter = (v.bool("show_poi") ?? true) ? .includingAll : .excludingAll
            options.preferredConfiguration = config
        }
        do {
            let shot = try await MKMapSnapshotter(options: options).start()
            return shot.image.pngData()?.base64EncodedString()
        } catch {
            throw DeviceBridge.Failure.io("the map could not be rendered: \(error.localizedDescription)")
        }
    }
}
