// src/carriers.js
// Mapa de carriers soportados por nuestra app.
// - alias: lo que escribe el usuario (telegram, etc.)
// - key: carrierKey de 17Track
// - name: nombre bonito para mostrar

const CARRIERS = {
    correos: { key: 19181, name: "Correos Spain" },
    correos_express: { key: 100048, name: "Correos Express" },
    seur: { key: 100438, name: "Seur" },
    mrw: { key: 100175, name: "MRW" },
    tipsa: { key: 100185, name: "TIPSA" },
    asm: { key: 100189, name: "GLS Spain (National) (ASM)" },
    asmred: { key: 100341, name: "Redur (ASM Red)" },
    asm_red: { key: 100341, name: "Redur (ASM Red)" },
    gls_es: { key: 100189, name: "GLS Spain (National)" },

    cainiao: { key: 190271, name: "Cainiao" },
    aliexpress: { key: 190625, name: "AliExpress" },
    yanwen: { key: 190012, name: "YANWEN" },
    fourpx: { key: 190094, name: "4PX" },
    sunyou: { key: 190072, name: "SUNYOU" },
    china_post: { key: 3011, name: "China Post" },
    ems: { key: 1043, name: "EMS" },
    sf_express: { key: 100012, name: "SF Express" },
    yunexpress: { key: 190008, name: "YunExpress" },
    jt: { key: 100074, name: "J&T Express" },

    postnl: { key: 14041, name: "PostNL" },
    bpost: { key: 2061, name: "Bpost" },
    colissimo: { key: 6051, name: "Colissimo" },
    laposte: { key: 2081, name: "La Poste" },
    royal_mail: { key: 11031, name: "Royal Mail" },

    dhl: { key: 7041, name: "DHL" },
    dpd: { key: 100007, name: "DPD" },
    gls: { key: 100005, name: "GLS" },
    ups: { key: 100002, name: "UPS" },
    fedex: { key: 100003, name: "FedEx" },
    tnt: { key: 100004, name: "TNT" },
    spring: { key: 100213, name: "Spring" }
};

module.exports = { CARRIERS };
