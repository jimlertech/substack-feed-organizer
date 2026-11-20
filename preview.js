(function () {
    const storageKey = "substack-publisher-groups-preview";
    const listeners = new Set();
    let values = {};
    try {
        values = JSON.parse(localStorage.getItem(storageKey) || "{}");
    } catch {
        values = {};
    }

    window.chrome = window.chrome || {};
    window.chrome.storage = {
        local: {
            async get(keys) {
                return Object.fromEntries(keys.map((key) => [key, values[key]]));
            },
            async set(nextValues) {
                const oldValues = { ...values };
                values = { ...values, ...nextValues };
                localStorage.setItem(storageKey, JSON.stringify(values));
                const changes = Object.fromEntries(
                    Object.keys(nextValues).map((key) => [
                        key,
                        { oldValue: oldValues[key], newValue: values[key] }
                    ])
                );
                for (const listener of listeners) {
                    listener(changes, "local");
                }
            }
        },
        onChanged: {
            addListener(listener) {
                listeners.add(listener);
            }
        }
    };
})();
