sub init()

    m.title = m.top.findNode("title")
    m.urlText = m.top.findNode("urlText")
    m.openButton = m.top.findNode("openButton")
    m.pageImage = m.top.findNode("pageImage")
    m.status = m.top.findNode("status")

    m.openButton.observeField("buttonSelected", "openPage")

    m.serverUrl = "https://navegador-roku1.onrender.com"

    m.status.text = "Servidor conectado"

end sub


sub openPage()

    url = m.urlText.text

    if url = invalid or url = ""

        m.status.text = "Digite uma URL."

        return

    end if

    if not url.instr("://") > 0

        url = "https://" + url

    end if

    m.status.text = "Abrindo página..."

    encodedUrl = url.Escape()

    imageUrl = m.serverUrl + "/browse?url=" + encodedUrl

    m.pageImage.uri = imageUrl

    m.status.text = "Página carregada."

end sub
