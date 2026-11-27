fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rerun-if-changed=resources/app.rc");
        println!("cargo:rerun-if-changed=resources/app.ico");
        embed_resource::compile_for("resources/app.rc", ["mbp-windows"], embed_resource::NONE)
            .manifest_required()
            .expect("could not embed the Windows application icon");
    }
}
