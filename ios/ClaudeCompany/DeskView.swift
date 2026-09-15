import SwiftUI

/// The screen: the web view edge to edge inside the safe area, a thin load bar along the
/// top while a page is fetching, and an "out of reach" card with a retry when it cannot be.
struct DeskView: View {
    @StateObject private var state = DeskState()

    private let ground = Color(red: Desk.ground.red, green: Desk.ground.green, blue: Desk.ground.blue)
    private let mint = Color(red: 0x5e / 255.0, green: 0xe9 / 255.0, blue: 0xb5 / 255.0)

    var body: some View {
        ZStack(alignment: .top) {
            ground.ignoresSafeArea()
            DeskWebView(state: state)
            if state.loading {
                ProgressView(value: min(max(state.progress, 0), 1))
                    .progressViewStyle(.linear)
                    .tint(mint)
                    .frame(height: 2)
            }
            if let failure = state.failure {
                OutOfReachCard(message: failure) {
                    state.failure = nil
                    state.reload?()
                }
            }
        }
        .background(ground)
        .preferredColorScheme(.dark)
        // claudeco://floor/12 from a message, a QR code or a floor's own page.
        .onOpenURL { url in
            if let target = Desk.route(url) { state.open?(target) }
        }
    }
}

/// Shown instead of a blank white view when the desk cannot be fetched.
struct OutOfReachCard: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack {
            Spacer()
            VStack(alignment: .leading, spacing: 12) {
                Text("The desk is out of reach")
                    .font(.title3.weight(.semibold))
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Text("The floor keeps working without you; this is only the window. Check the connection and try again.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Button(action: retry) {
                    Text("Try again")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(Color(red: 0x5e / 255.0, green: 0xe9 / 255.0, blue: 0xb5 / 255.0))
                .foregroundStyle(.black)
            }
            .padding(20)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .padding(20)
            Spacer()
        }
        .transition(.opacity)
    }
}
