# The Homebrew cask, as the Publish workflow writes it into the tap (dumkin/homebrew-tap) for every release:
# it fills in __REPO__, __VERSION__ and the checksum. Apple silicon only.
cask "k10s" do
  version "__VERSION__"
  sha256 "__SHA256__"

  url "https://github.com/__REPO__/releases/download/v#{version}/k10s_#{version}_aarch64.dmg"
  name "k10s"
  desc "Multi-cluster Kubernetes desktop client"
  homepage "https://github.com/__REPO__"

  livecheck do
    url :url
    strategy :github_latest
  end

  # k10s updates itself; `brew upgrade` leaves it alone.
  auto_updates true
  depends_on arch: :arm64

  app "k10s.app"

  zap trash: [
    "~/Library/Application Support/io.dumkin.k10s",
    "~/Library/Caches/io.dumkin.k10s",
    "~/Library/Logs/io.dumkin.k10s",
    "~/Library/Preferences/io.dumkin.k10s.plist",
    "~/Library/Saved Application State/io.dumkin.k10s.savedState",
    "~/Library/WebKit/io.dumkin.k10s",
  ]
end
